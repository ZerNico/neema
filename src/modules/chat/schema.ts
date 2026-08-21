import { Schema } from "effect";

export const SendMessageInput = Schema.Struct({
  conversationId: Schema.NullOr(Schema.String),
  modelId: Schema.String,
  content: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
  searchEnabled: Schema.Boolean,
});

export const ConversationIdInput = Schema.Struct({
  conversationId: Schema.String,
});

export const RetryMessageInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
});

export const RenameConversationInput = Schema.Struct({
  conversationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

export const standard = Schema.toStandardSchemaV1;
