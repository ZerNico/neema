import { Schema } from "effect";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./constants.ts";

// Client-visible attachment projection. Deliberately omits sha256, blob id and
// storage key — those would leak dedup information across users.
export const Attachment = Schema.Struct({
  id: Schema.String,
  fileName: Schema.String,
  size: Schema.Int,
  mediaType: Schema.String,
  kind: Schema.Literals(["image", "pdf", "text"]),
});
export type Attachment = typeof Attachment.Type;

// Conversation projection: a flat array the client groups by message, mirroring
// how tool calls are shipped.
export const MessageAttachment = Schema.Struct({
  ...Attachment.fields,
  messageId: Schema.String,
  position: Schema.Int,
});
export type MessageAttachment = typeof MessageAttachment.Type;

// Ordered id set sent with a message; order is the attachment position.
export const AttachmentIds = Schema.Array(Schema.String).check(
  Schema.isMaxLength(MAX_ATTACHMENTS_PER_MESSAGE),
);

export const AttachmentIdInput = Schema.Struct({
  attachmentId: Schema.String,
});
