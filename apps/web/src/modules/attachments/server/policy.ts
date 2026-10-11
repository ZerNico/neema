/**
 * The single place that decides who may read an attachment's bytes.
 *
 * Today it is "you uploaded it" or "it hangs off a message in a conversation
 * you own", unless a document holds it as an image: then only the document's
 * route serves it, to the document's readers. When conversations become shareable, the second clause becomes a
 * membership lookup and nothing else in the codebase has to change, which is
 * exactly why every read path goes through here instead of comparing user ids
 * inline.
 */
export const canAccessAttachment = (
  userId: string,
  record: {
    attachment: { userId: string };
    conversationUserId: string | null;
    claimedByDocument: boolean;
  },
): boolean =>
  // A document's image is read through that document's route only, whose access
  // is checked every time and can be taken away; here it would be the uploader's for good.
  !record.claimedByDocument &&
  (record.attachment.userId === userId || record.conversationUserId === userId);
