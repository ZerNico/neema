import type { IpcRenderer } from "electron";
import type { DesktopAuth } from "@chat/desktop-rpc";
import { CHANGE_SERVER, FIXED_SERVER_ARGUMENT } from "./chrome.ts";
import { SIGN_IN_TICKET } from "./sign-in-link.ts";

/** Main decides this before any window exists, so the preload reads it from its arguments. */
export const canChangeServer = (argv: readonly string[]) => !argv.includes(FIXED_SERVER_ARGUMENT);

export const makeAuthBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  argv: readonly string[],
): DesktopAuth => ({
  canChangeServer: canChangeServer(argv),
  onTicket: (listener) => {
    const receive = (_event: unknown, ticket: unknown) => {
      if (typeof ticket === "string") listener(ticket);
    };
    ipc.on(SIGN_IN_TICKET, receive);
    return () => {
      ipc.removeListener(SIGN_IN_TICKET, receive);
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
});
