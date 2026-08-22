import { Schema } from "effect";

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { conversationId: Schema.String },
) {}

export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()("MessageNotFound", {
  messageId: Schema.String,
}) {}

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()("ModelNotFound", {
  modelId: Schema.String,
}) {}

export class RetryNotAllowed extends Schema.TaggedError<RetryNotAllowed>()("RetryNotAllowed", {
  messageId: Schema.String,
  reason: Schema.String,
}) {}

export class EditNotAllowed extends Schema.TaggedError<EditNotAllowed>()("EditNotAllowed", {
  messageId: Schema.String,
  reason: Schema.String,
}) {}

export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()("GenerationFailed", {
  messageId: Schema.String,
  message: Schema.String,
}) {}

// A turn that carries neither text nor attachments has nothing to send.
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Schema.String,
}) {}
