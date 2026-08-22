/**
 * The single place that decides who may read an attachment's bytes.
 *
 * Today it is "you uploaded it" or "it hangs off a message in a conversation
 * you own". When conversations become shareable, the second clause becomes a
 * membership lookup and nothing else in the codebase has to change — which is
 * exactly why every read path goes through here instead of comparing user ids
 * inline.
 */
export const canAccessAttachment = (
  userId: string,
  record: {
    attachment: { userId: string };
    conversationUserId: string | null;
  },
): boolean => record.attachment.userId === userId || record.conversationUserId === userId;
