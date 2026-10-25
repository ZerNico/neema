import { Schema } from "effect";
import { Localized } from "~/i18n/localized.ts";

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
  reason: Localized,
}) {}

export class ResumeNotAllowed extends Schema.TaggedError<ResumeNotAllowed>()("ResumeNotAllowed", {
  messageId: Schema.String,
  reason: Localized,
}) {}

export class BranchNotAllowed extends Schema.TaggedError<BranchNotAllowed>()("BranchNotAllowed", {
  messageId: Schema.String,
  reason: Localized,
}) {}

export class EditNotAllowed extends Schema.TaggedError<EditNotAllowed>()("EditNotAllowed", {
  messageId: Schema.String,
  reason: Localized,
}) {}

export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()("GenerationFailed", {
  messageId: Schema.String,
  message: Schema.String,
}) {}

/**
 * A turn that carries neither text nor attachments has nothing to send.
 */
export class InvalidMessage extends Schema.TaggedError<InvalidMessage>()("InvalidMessage", {
  reason: Localized,
}) {}

/**
 * A generation is still streaming in this conversation. Retry and edit refuse
 * this case explicitly; sending must too, or a second tab can start a
 * concurrent generation whose history misses the in-flight answer.
 */
export class QueueFull extends Schema.TaggedError<QueueFull>()("QueueFull", {
  conversationId: Schema.String,
}) {}

export class QueueEntryNotFound extends Schema.TaggedError<QueueEntryNotFound>()(
  "QueueEntryNotFound",
  { entryId: Schema.String },
) {}

export class NoActiveGeneration extends Schema.TaggedError<NoActiveGeneration>()(
  "NoActiveGeneration",
  { conversationId: Schema.String },
) {}

export class ConversationBusy extends Schema.TaggedError<ConversationBusy>()("ConversationBusy", {
  conversationId: Schema.String,
}) {}

/**
 * A work chat acts on the user's machine, which only the desktop app can
 * reach. A send from a browser tab is refused rather than run as a plain chat
 * the model cannot explain. A folder is not required: the chat can start
 * without one and attach it later.
 */
export class WorkDesktopRequired extends Schema.TaggedError<WorkDesktopRequired>()(
  "WorkDesktopRequired",
  {},
) {}
