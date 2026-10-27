/**
 * Optional sign-in capability, independent of the bridge's protocol version.
 *
 * The shell hands sign-in to the system browser; the ticket the browser page
 * mints comes back through a deep link and is delivered here for redemption.
 * A page can also ask the shell to reopen its server chooser, and nothing
 * more: the new address is typed there, never sent by the page.
 */
export interface DesktopAuth {
  onTicket(listener: (ticket: string) => void): () => void;
  /** False while a developer pinned the server; the site then offers no switch at all. */
  readonly canChangeServer: boolean;
  changeServer(): Promise<void>;
}

export function readDesktopAuth(): DesktopAuth | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const auth = Reflect.get(channel, "auth");
  if (typeof auth !== "object" || auth === null) return null;
  if (
    typeof auth.onTicket !== "function" ||
    typeof auth.changeServer !== "function" ||
    typeof auth.canChangeServer !== "boolean"
  )
    return null;
  return auth as DesktopAuth;
}
