import { KNOWLEDGE_LIMITS } from "~/modules/knowledge/schema.ts";
import { MAX_SEARCH_LENGTH } from "~/modules/search/text.ts";
import { Schema } from "effect";
import { QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import { Attachment, AttachmentIds } from "~/modules/attachments/schema.ts";
import { WorkspaceId } from "@chat/desktop-rpc";
import { REASONING_EFFORTS } from "~/modules/providers/model-config.ts";
import { EntityId } from "~/entity-id.ts";

// Blank content is allowed when the turn carries attachments; the service
// rejects the turn that has neither.
const MessageContent = Schema.String.check(Schema.isMaxLength(32_000));

const TimeZone = Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100)));

/**
 * The document open in the panel when the message was sent, which the model
 * reads first, the blocks the person had selected in it, and the comment
 * thread the message was sent from.
 */
export const OpenDocument = Schema.Struct({
  id: EntityId,
  thread: Schema.optionalKey(EntityId),
  selected: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))).check(
      Schema.isMaxLength(50),
    ),
  ),
});
export type OpenDocument = typeof OpenDocument.Type;
const OpenDocumentField = Schema.optionalKey(OpenDocument);
/**
 * What the desktop app adds to a submission sent from it. Absent from a browser. Not where a
 * chat's computer is decided: that is the chat's bound machine (docs/internals/desktop.md).
 */
export const DesktopSubmission = Schema.Struct({
  /** The app's execution session, which runs this attempt's browser calls in its pages. */
  executorId: EntityId,
  /** The machine sending, offered first when the chat has no computer yet. */
  machineId: Schema.optionalKey(EntityId),
  /** Whether the app can drive embedded pages, which offers the browser tools. */
  browser: Schema.Boolean,
});
export type DesktopSubmission = typeof DesktopSubmission.Type;
const DesktopField = Schema.optionalKey(DesktopSubmission);

const generationFields = {
  timeZone: TimeZone,
  openDocument: OpenDocumentField,
  modelId: Schema.String,
  /** The composer's image model; absent or null keeps the chat's own. */
  imageModelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.Literals(REASONING_EFFORTS))),
  content: MessageContent,
  searchEnabled: Schema.Boolean,
  /** Offers `deep_research` to the attempt; the model still chooses. */
  researchEnabled: Schema.Boolean,
  desktop: DesktopField,
  // Ordered: index = position in the message.
  attachmentIds: AttachmentIds,
  /**
   * Installs the fixed agent association on the first message only.
   * Each later attempt resolves its current settings; the association cannot change.
   */
  agentId: Schema.optionalKey(Schema.NullOr(EntityId)),
  skillIds: Schema.optionalKey(Schema.Array(EntityId).check(Schema.isMaxLength(5))),
  /** Standalone collections beside the agent's; omitted keeps the current selection. */
  collectionIds: Schema.optionalKey(
    Schema.Array(EntityId).check(Schema.isMaxLength(KNOWLEDGE_LIMITS.maxCollectionsPerSelection)),
  ),
  /**
   * Account toggles made before the chat existed. An existing chat saves
   * each toggle as it happens, so this only matters for a first message.
   */
  integrationChoices: Schema.optionalKey(
    Schema.Array(Schema.Struct({ connectionId: EntityId, enabled: Schema.Boolean })).check(
      Schema.isMaxLength(20),
    ),
  ),
};

/** How long a temporary chat outlives its last message. */
export const TEMPORARY_CHAT_HOURS = 24;

/**
 * How long a deleted chat waits for Undo before the sweep purges it. Well past
 * the toast that offers Undo, so the two never race.
 */
export const DELETED_CHAT_GRACE_SECONDS = 120;

export const ConversationReference = Schema.Union([
  Schema.Struct({
    kind: Schema.Literals(["new"]),
    id: WorkspaceId,
    temporary: Schema.optionalKey(Schema.Boolean),
    /** Starts the chat inside a project; authorized in the attempt that creates it. */
    projectId: Schema.optionalKey(EntityId),
  }),
  Schema.Struct({ kind: Schema.Literals(["existing"]), id: Schema.String }),
]);
export type ConversationReference = typeof ConversationReference.Type;

export const SendMessageInput = Schema.Struct({
  conversation: ConversationReference,
  ...generationFields,
});

/** One ```ui block's state; the JSON the block's runtime reported, at most 16 KB. */
export const SaveUiStateInput = Schema.Struct({
  messageId: Schema.String,
  /** Null for an answer a branch copied, which has no attempt of its own. */
  generationId: Schema.NullOr(Schema.String),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
  sourceHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)),
  state: Schema.String.check(Schema.isMaxLength(16 * 1024)),
  digest: Schema.NullOr(Schema.String.check(Schema.isMaxLength(2_000))),
});

const MapPoint = Schema.Struct({
  lat: Schema.Finite.check(Schema.isBetween({ minimum: -90, maximum: 90 })),
  lng: Schema.Finite.check(Schema.isBetween({ minimum: -180, maximum: 180 })),
});

export const LookupUiMapInput = Schema.Struct({
  messageId: Schema.String,
  generationId: Schema.NullOr(Schema.String),
  ordinal: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 7 })),
  places: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(Schema.isMaxLength(40)),
  routes: Schema.Array(
    Schema.Struct({
      mode: Schema.Literals(["drive", "walk", "bike"]),
      stops: Schema.Array(
        Schema.Union([Schema.String.check(Schema.isMaxLength(200)), MapPoint]),
      ).check(Schema.isMinLength(2), Schema.isMaxLength(10)),
    }),
  ).check(Schema.isMaxLength(10)),
});

export const AnswerQuestionInput = Schema.Struct({
  conversationId: Schema.String,
  callId: Schema.String,
  response: QuestionResponse,
  modelId: Schema.String,
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.Literals(REASONING_EFFORTS))),
  desktop: DesktopField,
  timeZone: TimeZone,
  openDocument: OpenDocumentField,
});

export const ConversationIdInput = Schema.Struct({
  conversationId: Schema.String,
});

/** An Undo names the delete it reverses by the mark that delete returned. */
export const ConversationRestoreInput = Schema.Struct({
  conversationId: Schema.String,
  mark: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)),
});

export const ConversationArchiveInput = Schema.Struct({
  conversationId: Schema.String,
  archived: Schema.Boolean,
});

export const ConversationDetailInput = Schema.Struct({
  conversationId: Schema.String,
  /** The first message the view already shows; see `loadConversationDetail`. */
  anchorId: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

export const ConversationHistoryInput = Schema.Struct({
  conversationId: Schema.String,
  /** The first message loaded so far; the page ends just before it. */
  beforeId: Schema.String,
});

/** Opaque to the client: it hands back whatever the previous page returned. */
export const ConversationCursor = Schema.Struct({
  /** ISO timestamp of coalesce(lastMessageAt, createdAt) for the last row served. */
  activity: Schema.String,
  id: Schema.String,
});

export const ListConversationsInput = Schema.Struct({
  /** Case-insensitive substring match on the title; blank lists everything. */
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_SEARCH_LENGTH))),
  cursor: Schema.optionalKey(ConversationCursor),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  /** The sidebar lists a project's chats under the project instead. */
  outsideProjects: Schema.optionalKey(Schema.Boolean),
});

export const SearchChatsInput = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(MAX_SEARCH_LENGTH)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
});

/**
 * Queueing snapshots an ordinary submission, files included. `desktop` is
 * checked at queue time but never stored: a Work entry takes fresh ones
 * from the app that dispatches it.
 */
export const QueueMessageInput = Schema.Struct({
  conversationId: Schema.String,
  modelId: Schema.String,
  /** The composer's image model; absent or null keeps the chat's own. */
  imageModelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.Literals(REASONING_EFFORTS))),
  content: MessageContent,
  searchEnabled: Schema.Boolean,
  researchEnabled: Schema.Boolean,
  desktop: DesktopField,
  attachmentIds: AttachmentIds,
  timeZone: TimeZone,
  openDocument: OpenDocumentField,
  skillIds: Schema.optionalKey(Schema.Array(EntityId).check(Schema.isMaxLength(5))),
  collectionIds: Schema.optionalKey(
    Schema.Array(EntityId).check(Schema.isMaxLength(KNOWLEDGE_LIMITS.maxCollectionsPerSelection)),
  ),
});

export const ReplaceQueueEntryInput = Schema.Struct({
  ...QueueMessageInput.fields,
  entryId: Schema.String,
});

/**
 * Starts the next queued message. `force` is a person asking, which may start
 * after a stop; `desktop` is how a Work chat's entry gets a machine.
 */
export const DispatchQueueInput = Schema.Struct({
  conversationId: Schema.String,
  force: Schema.optionalKey(Schema.Boolean),
  desktop: DesktopField,
});

export const QueueEntryIdInput = Schema.Struct({
  conversationId: Schema.String,
  entryId: Schema.String,
});

/** Sends one queued message now; `desktop` gives a Work entry its machine. */
export const SendQueuedNowInput = Schema.Struct({
  conversationId: Schema.String,
  entryId: Schema.String,
  desktop: DesktopField,
});

export const SteerQueueEntryInput = Schema.Struct({
  conversationId: Schema.String,
  entryId: Schema.String,
  messageId: Schema.String,
  generationId: Schema.String,
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
  desktop: DesktopField,
  conversationId: Schema.String,
  messageId: Schema.String,
  modelId: Schema.optionalKey(Schema.String),
  /** The composer's image model; absent or null keeps the chat's own. */
  imageModelId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timeZone: TimeZone,
  openDocument: OpenDocumentField,
});

/** Continues the last answer; the same fields as a retry. */
export const ResumeMessageInput = RetryMessageInput;

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
    reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.Literals(REASONING_EFFORTS))),
    desktop: DesktopField,
    timeZone: TimeZone,
    openDocument: OpenDocumentField,
    attachmentIds: AttachmentIds,
    questionResponse: QuestionResponse,
    content: Schema.optionalKey(Schema.Never),
  }),
]);

/** How much a chat's computer asks before acting; deletes and network always ask. */
export const PermissionLevel = Schema.Literals(["ask", "allow"]);
export type PermissionLevel = typeof PermissionLevel.Type;

export const SetPermissionLevelInput = Schema.Struct({
  conversationId: Schema.String,
  permissionLevel: PermissionLevel,
});

export const ConversationTitle = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SEARCH_LENGTH),
);

export const RenameConversationInput = Schema.Struct({
  conversationId: Schema.String,
  title: ConversationTitle,
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

/**
 * Envelope persisted in message_chunks.delta for kind:"steer": a queued
 * message the running answer took in at a tool boundary. The row is the
 * record; this puts it in the stream at the moment it happened, so the answer
 * shows it in order and a resume replays it there.
 */
export const SteerChunkEnvelope = Schema.Struct({
  v: Schema.Literals([1]),
  /** The user message the steer became. */
  id: Schema.String,
  /** The queue entry it came from, so the strip can drop it at once. */
  queueEntryId: Schema.String,
  content: Schema.String,
  textOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  turnIndex: Schema.Int,
  attachments: Schema.Array(Attachment),
});
export type SteerChunkEnvelope = typeof SteerChunkEnvelope.Type;

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
