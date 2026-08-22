import { Schema } from "effect";
import { AttachmentIds } from "~/modules/attachments/schema.ts";

// Blank content is allowed when the turn carries attachments; the service
// rejects the turn that has neither.
const MessageContent = Schema.String.check(Schema.isMaxLength(32_000));

const generationFields = {
  modelId: Schema.String,
  content: MessageContent,
  searchEnabled: Schema.Boolean,
  // Ordered: index = position in the message.
  attachmentIds: AttachmentIds,
};

export const SendMessageInput = Schema.Struct({
  conversationId: Schema.NullOr(Schema.String),
  ...generationFields,
});

export const ConversationIdInput = Schema.Struct({
  conversationId: Schema.String,
});

// Opaque to the client: it hands back whatever the previous page returned.
export const ConversationCursor = Schema.Struct({
  /** ISO timestamp of coalesce(lastMessageAt, createdAt) for the last row served. */
  activity: Schema.String,
  id: Schema.String,
});

export const ListConversationsInput = Schema.Struct({
  /** Case-insensitive substring match on the title; blank lists everything. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optionalKey(ConversationCursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

export const MessageIdInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
});

// Omitting `modelId` regenerates with whatever model produced the answer;
// sending one switches models for the new attempt ("retry with").
export const RetryMessageInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
  modelId: Schema.optionalKey(Schema.String),
});

export const EditMessageInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
  ...generationFields,
});

export const RenameConversationInput = Schema.Struct({
  conversationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const standard = Schema.toStandardSchemaV1;
