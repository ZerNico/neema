import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { Schema } from "effect";
import { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { AttachmentIds } from "~/modules/attachments/schema.ts";
import { LocalTransactionId, WorkspaceId } from "@chat/desktop-rpc";

// Blank content is allowed when the turn carries attachments; the service
// rejects the turn that has neither.
const MessageContent = Schema.String.check(Schema.isMaxLength(32_000));

const TimeZone = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)));

const ResourceId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
/** The document open in the panel when the message was sent; the model reads it first. */
const OpenDocumentId = Schema.optionalKey(ResourceId);
export const desktopSubmissionFields = {
  /**
   * The folders reachable on the sending machine, by real absolute path. Paths
   * live in attempt-scoped prompt text and tool traffic, never in a row: the
   * generation config keeps the names alone, so the same conversation
   * continued on another machine resolves its own folders or none.
   */
  desktopFolders: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
        path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
      }),
    ).check(Schema.isMaxLength(32)),
  ),
  desktopCommands: Schema.optionalKey(Schema.Boolean),
  fromDesktop: Schema.optionalKey(Schema.Boolean),
  desktopExecutorId: Schema.optionalKey(ResourceId),
  /**
   * Which machine sent the attempt. Stored per generation so the client can
   * tell "this chat last worked here" from "elsewhere" and offer take-over.
   * Display text only; names are never an address.
   */
  desktopMachineId: Schema.optionalKey(ResourceId),
  desktopMachineName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
};
const DesktopSubmission = Schema.Struct(desktopSubmissionFields);
export type DesktopSubmission = {
  [K in keyof typeof DesktopSubmission.Type]?: (typeof DesktopSubmission.Type)[K] | undefined;
};

const generationFields = {
  timeZone: TimeZone,
  openDocumentId: OpenDocumentId,
  modelId: Schema.String,
  content: MessageContent,
  searchEnabled: Schema.Boolean,
  /** Offers `deep_research` to the attempt; the model still chooses. */
  researchEnabled: Schema.Boolean,
  ...desktopSubmissionFields,
  // Ordered: index = position in the message.
  attachmentIds: AttachmentIds,
  /**
   * Installs the fixed agent association on the first message only.
   * Each later attempt resolves its current settings; the association cannot change.
   */
  agentId: Schema.optionalKey(Schema.NullOr(ResourceId)),
  skillIds: Schema.optionalKey(Schema.Array(ResourceId).check(Schema.isMaxLength(5))),
  /** Standalone collections beside the agent's; omitted keeps the current selection. */
  collectionIds: Schema.optionalKey(
    Schema.Array(ResourceId).check(Schema.isMaxLength(KNOWLEDGE_LIMITS.maxCollectionsPerSelection)),
  ),
};

export const ConversationMode = Schema.Literals(["chat", "work"]);
export type ConversationMode = typeof ConversationMode.Type;

export const ConversationReference = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["new"]), id: WorkspaceId, mode: ConversationMode }),
  Schema.Struct({ kind: Schema.Literals(["existing"]), id: Schema.String }),
]);
export type ConversationReference = typeof ConversationReference.Type;

const WorkspaceFiles = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
).check(Schema.isMaxLength(50));

const sendFields = {
  ...generationFields,
  /** Names only; absolute workspace paths remain attempt-scoped desktop fields. */
  workspaceFiles: Schema.optionalKey(WorkspaceFiles),
};

export const SendMessageInput = Schema.Struct({
  conversation: ConversationReference,
  ...sendFields,
});

export const ReserveWorkTurnInput = Schema.Struct({
  reservationId: LocalTransactionId,
  conversation: ConversationReference,
});

export const ActivateWorkTurnInput = Schema.Struct({
  reservationId: LocalTransactionId,
  conversation: ConversationReference,
  ...sendFields,
  workspaceFiles: WorkspaceFiles.check(Schema.isMinLength(1)),
});

export const WorkTurnReservationInput = Schema.Struct({
  reservationId: LocalTransactionId,
});

export const WorkTurnReservationStatus = Schema.Struct({
  reservationId: LocalTransactionId,
  conversationId: WorkspaceId,
  status: Schema.Literals(["reserved", "activated", "aborted", "expired"]),
  assistantMessageId: Schema.NullOr(Schema.String),
});

export const AnswerQuestionInput = Schema.Struct({
  conversationId: Schema.String,
  callId: Schema.String,
  response: QuestionResponse,
  modelId: Schema.String,
  searchEnabled: Schema.Boolean,
  researchEnabled: Schema.Boolean,
  ...desktopSubmissionFields,
  timeZone: TimeZone,
  openDocumentId: OpenDocumentId,
});

export const ConversationIdInput = Schema.Struct({
  conversationId: Schema.String,
});

/** Opaque to the client: it hands back whatever the previous page returned. */
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
  generationId: Schema.optionalKey(Schema.String),
  conversationId: Schema.String,
  messageId: Schema.String,
});

/**
 * Omitting `modelId` regenerates with whatever model produced the answer;
 * sending one switches models for the new attempt ("retry with").
 */
export const RetryMessageInput = Schema.Struct({
  ...desktopSubmissionFields,
  conversationId: Schema.String,
  messageId: Schema.String,
  modelId: Schema.optionalKey(Schema.String),
  timeZone: TimeZone,
  openDocumentId: OpenDocumentId,
});

/** Forks the conversation at this assistant message into a new one. */
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
    researchEnabled: Schema.Boolean,
    ...desktopSubmissionFields,
    timeZone: TimeZone,
    openDocumentId: OpenDocumentId,
    attachmentIds: AttachmentIds,
    questionResponse: QuestionResponse,
    content: Schema.optionalKey(Schema.Never),
  }),
]);

export const PermissionLevel = Schema.Literals(["manual", "auto", "skip"]);
export type PermissionLevel = typeof PermissionLevel.Type;

export const UpdateWorkSettingsInput = Schema.Struct({
  conversationId: Schema.String,
  permissionLevel: PermissionLevel,
});

export const RenameConversationInput = Schema.Struct({
  conversationId: Schema.String,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});

// Envelope persisted in message_chunks.delta for kind:"compaction" markers.
// Compaction runs to completion before the first answer token, so without
// these the UI shows nothing for however long it takes. `result` carries the
// summary so the finished block reads the same live as after a checkpoint
// refetch.
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
