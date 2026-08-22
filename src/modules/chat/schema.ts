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

export const RetryMessageInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
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
