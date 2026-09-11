import { Schema } from "effect";

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { conversationId: Schema.String },
) {}

export class MessageNotFound extends Schema.TaggedError<MessageNotFound>()("MessageNotFound", {
  messageId: Schema.String,
}) {}

export class QuestionUnavailable extends Schema.TaggedError<QuestionUnavailable>()(
  "QuestionUnavailable",
  {
    callId: Schema.String,
  },
) {}

export class ModelNotFound extends Schema.TaggedError<ModelNotFound>()("ModelNotFound", {
  modelId: Schema.String,
}) {}

export class RetryNotAllowed extends Schema.TaggedError<RetryNotAllowed>()("RetryNotAllowed", {
  messageId: Schema.String,
  reason: Schema.String,
}) {}

export class BranchNotAllowed extends Schema.TaggedError<BranchNotAllowed>()("BranchNotAllowed", {
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

// A generation is still streaming in this conversation. Retry and edit refuse
// this case explicitly; sending must too, or a second tab can start a
// concurrent generation whose history misses the in-flight answer.
export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
  conversationId: Schema.String,
}) {}

// A work chat runs against a folder on the user's machine. A send without one,
// from a browser tab or before a folder is chosen, is refused rather than run
// as a plain chat the model cannot explain.
export class WorkFolderRequired extends Schema.TaggedError<WorkFolderRequired>()(
  "WorkFolderRequired",
  {},
) {}
