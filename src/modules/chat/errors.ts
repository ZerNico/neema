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

export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()("GenerationFailed", {
  messageId: Schema.String,
  message: Schema.String,
}) {}
