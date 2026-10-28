/**
 * A chat across servers: one app driver serves every server's chats, and two servers may hold
 * chats of the same id. The server's origin, then the conversation.
 */
export const chatKey = (origin: string, conversationId: string) =>
  `${origin}\u0000${conversationId}`;

export const parseChatKey = (chat: string) => {
  const split = chat.indexOf("\u0000");
  return split < 0 ? null : { scope: chat.slice(0, split), conversationId: chat.slice(split + 1) };
};
