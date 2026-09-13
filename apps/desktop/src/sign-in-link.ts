/**
 * The deep link the browser's sign-in page hands back to the shell. Pure, so
 * the parsing can be tested without Electron; main.ts wires the events.
 */
export const SIGN_IN_SCHEME = "chat-desktop";
export const SIGN_IN_TICKET = "chat-desktop:sign-in-ticket";
/** Product token appended to the user agent; the server keys its desktop policy on it. */
export const USER_AGENT_PRODUCT = "ChatDesktop";

/** The build stamp is "<sha> <date> <time>"; a product token cannot carry spaces. */
export const userAgentToken = (buildStamp: string) =>
  `${USER_AGENT_PRODUCT}/${buildStamp.split(" ")[0] || "unknown"}`;

/** Only `chat-desktop://sign-in?ticket=…` carries a ticket; anything else is noise. */
export const ticketFromDeepLink = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${SIGN_IN_SCHEME}:`) return null;
  // Chromium parses a custom scheme as opaque, so the host lands in the path.
  const target = `${parsed.host}${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
  if (target !== "sign-in") return null;
  const ticket = parsed.searchParams.get("ticket")?.trim() ?? "";
  return ticket === "" ? null : ticket;
};

/** Windows and Linux deliver the link as an argument of a second instance. */
export const ticketFromArgv = (argv: readonly string[]): string | null => {
  for (const argument of argv) {
    const ticket = ticketFromDeepLink(argument);
    if (ticket !== null) return ticket;
  }
  return null;
};
