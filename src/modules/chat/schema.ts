import { Schema } from "effect";
import { GenerationMode } from "./research-schema.ts";
import { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { AttachmentIds } from "~/modules/attachments/schema.ts";

// Blank content is allowed when the turn carries attachments; the service
// rejects the turn that has neither.
const MessageContent = Schema.String.check(Schema.isMaxLength(32_000));

const TimeZone = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)));

const generationFields = {
  generationMode: Schema.optionalKey(GenerationMode),
  timeZone: TimeZone,
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

export const AnswerQuestionInput = Schema.Struct({
  conversationId: Schema.String,
  callId: Schema.String,
  response: QuestionResponse,
  modelId: Schema.String,
  searchEnabled: Schema.Boolean,
  timeZone: TimeZone,
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
  researchRunId: Schema.optionalKey(Schema.String),
  conversationId: Schema.String,
  messageId: Schema.String,
});

// Omitting `modelId` regenerates with whatever model produced the answer;
// sending one switches models for the new attempt ("retry with").
export const RetryMessageInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
  modelId: Schema.optionalKey(Schema.String),
  timeZone: TimeZone,
});

// Forks the conversation at this assistant message into a new one.
export const BranchConversationInput = Schema.Struct({
  conversationId: Schema.String,
  messageId: Schema.String,
});

export const EditMessageInput = Schema.Union([
  Schema.Struct({
    conversationId: Schema.String,
    messageId: Schema.String,
    ...generationFields,
    questionResponse: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    conversationId: Schema.String,
    messageId: Schema.String,
    modelId: Schema.String,
    searchEnabled: Schema.Boolean,
    timeZone: TimeZone,
    attachmentIds: AttachmentIds,
    questionResponse: QuestionResponse,
    content: Schema.optionalKey(Schema.Never),
  }),
]);

export const RenameConversationInput = Schema.Struct({
  conversationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

// Envelope persisted in message_chunks.delta for kind:"compaction" markers.
// Compaction runs to completion before the first token of the answer, so
// without these the UI has nothing to show for however long it takes.
// `result` carries the summary so the finished block reads the same live as
// it does after the conversation refetches the checkpoint.
const compactionPositionFields = {
  runId: Schema.optionalKey(Schema.String),
  taskId: Schema.optionalKey(Schema.String),
  eventId: Schema.String,
  beforeTurnIndex: Schema.Int,
  passIndex: Schema.Int,
  textOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  scope: Schema.Literals(["history", "active_rounds"]),
};

export const CompactionChunkEnvelope = Schema.Union([
  Schema.Struct({
    v: Schema.Literals([1]),
    phase: Schema.Literals(["start"]),
    ...compactionPositionFields,
  }),
  Schema.Struct({
    v: Schema.Literals([1]),
    phase: Schema.Literals(["result"]),
    ...compactionPositionFields,
    ok: Schema.Boolean,
    outcome: Schema.optionalKey(Schema.Literals(["summary", "hard_truncation"])),
    summary: Schema.optionalKey(Schema.String),
  }),
]);
export type CompactionChunkEnvelope = typeof CompactionChunkEnvelope.Type;

export const standard = Schema.toStandardSchemaV1;
