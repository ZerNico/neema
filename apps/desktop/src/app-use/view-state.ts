import type { AppUsePlacement } from "@chat/desktop-rpc";

/**
 * Whether the floating window shows a chat's view. Where the person put it, as long as there is
 * something to show; and by itself while the chat uses apps and neema's window is minimized or
 * hidden, as Codex's picture in picture comes up when its window is minimized. Closing it keeps
 * it away until the chat's next spell of app use.
 */
export const floats = (chat: {
  readonly placement: AppUsePlacement;
  readonly dismissed: boolean;
  readonly live: boolean;
  readonly hasFrame: boolean;
  readonly mainVisible: boolean;
}) =>
  !chat.dismissed &&
  chat.hasFrame &&
  (chat.placement === "floating" || (chat.live && !chat.mainVisible));

/** A chat as `AppUse.key` names it: the server's origin, then the conversation. */
export const parseChatKey = (chat: string) => {
  const split = chat.indexOf("\u0000");
  return split < 0 ? null : { scope: chat.slice(0, split), conversationId: chat.slice(split + 1) };
};
