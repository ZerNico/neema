import type { IpcRenderer } from "electron";
import type { DesktopAuth } from "@chat/desktop-rpc";
import { CHANGE_SERVER, FIXED_SERVER_ARGUMENT } from "./chrome.ts";
import { SIGN_IN_TICKET } from "./sign-in-link.ts";

/** Main decides this before any window exists, so the preload reads it from its arguments. */
export const canChangeServer = (argv: readonly string[]) => !argv.includes(FIXED_SERVER_ARGUMENT);

export const makeAuthBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  argv: readonly string[],
): DesktopAuth => {
  // Main sends the ticket as soon as the frame has loaded, before the page has
  // mounted its login screen and subscribed. The preload runs first and lives
  // as long as the document, so it holds the ticket for the next subscriber.
  let held: string | null = null;
  const listeners = new Set<(ticket: string) => void>();
  ipc.on(SIGN_IN_TICKET, (_event: unknown, ticket: unknown) => {
    if (typeof ticket !== "string") return;
    if (listeners.size === 0) held = ticket;
    for (const listener of listeners) listener(ticket);
  });
  return {
    canChangeServer: canChangeServer(argv),
    onTicket: (listener) => {
      listeners.add(listener);
      if (held !== null) {
        const ticket = held;
        held = null;
        listener(ticket);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    changeServer: async () => {
      const outcome: unknown = await ipc.invoke(CHANGE_SERVER);
      if (outcome && typeof outcome === "object" && "ok" in outcome && outcome.ok === false)
        throw new Error(
          "message" in outcome && typeof outcome.message === "string"
            ? outcome.message
            : "Could not change server.",
        );
    },
  };
};
