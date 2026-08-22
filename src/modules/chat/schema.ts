import { Schema } from "effect";

const MessageContent = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(32_000),
  Schema.isPattern(/\S/),
);

const generationFields = {
  modelId: Schema.String,
  content: MessageContent,
  searchEnabled: Schema.Boolean,
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
