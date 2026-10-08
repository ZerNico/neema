import type { UsageEventInput } from "~/modules/analytics/server/repo.ts";
import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { GenerationFence, lockGeneration, type GenerationIdentity } from "./generation-fence.ts";
import type { UiImageResult, UiImages } from "../assistant-output.ts";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  ne,
  not,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  type AskUserParams,
  QuestionResponse,
  formatQuestionResponse,
  readPresentedQuestions,
  readQuestionResponse,
  readStoredQuestionPresentation,
} from "~/modules/tools/ask-user-schema.ts";
import { extractUserUrls } from "~/modules/tools/server/user-urls.ts";
import type { QueuedTurnInput } from "../queued-turn.ts";
import { composeFileReferenceAliases } from "../file-reference-aliases.ts";
import { TEMPORARY_CHAT_HOURS } from "../schema.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import { projectResearchProgress } from "../research-schema.ts";
import { createResearchStore, type ResearchStore } from "./research/repo.ts";
import { researchRuns, researchTasks } from "~/db/schema/research.ts";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import {
  conversationAgents,
  conversationCompactionCheckpoints,
  conversationDrafts,
  documents,
  conversations,
  conversationQueueEntries,
  messageChunks,
  messageAttachments,
  messageCompactionEvents,
  messageGenerationConfig,
  messageSkills,
  messageKnowledgeVersions,
  messages,
  messageToolCalls,
  messageUiStates,
  toolCallDebugArguments,
  schedules,
  scheduleRuns,
  usageEvents,
  workTurnReservations,
  conversationIntegrations,
} from "~/db/schema/index.ts";
import { readKeptWorkingFiles } from "./kept-working-files.ts";
import type { ResolvedAgentConfig } from "~/db/schema/agents.ts";
import type { ResolvedProject } from "~/modules/projects/schema.ts";
import { projectRole } from "~/modules/projects/server/access.ts";
import type { AgentNotAvailable } from "~/modules/agents/errors.ts";
import type { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import type { ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import { CustomToolActivity } from "~/modules/custom-tools/tool-schema.ts";
import { isCustomToolName } from "~/modules/custom-tools/schema.ts";
import { ToolFileActivity } from "../tool-file-schema.ts";
import type { AttachmentNotAvailable } from "~/modules/attachments/errors.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { AttachmentRepo, type DbTx } from "~/modules/attachments/server/repo.ts";
import { escapeLike } from "~/server/sql.ts";
import { hashSource, MAX_UI_BLOCKS, scanUiFences } from "~/modules/genui/fences.ts";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  prefixTsQuery,
  snippetFromHeadline,
  type Snippet,
} from "~/modules/search/text.ts";
import {
  BranchNotAllowed,
  ConversationBusy,
  ConversationNotFound,
  NoActiveGeneration,
  QueueEntryNotFound,
  QueueFull,
  MessageNotFound,
  InvalidMessage,
  QuestionUnavailable,
  WorkDesktopRequired,
} from "../errors.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

export type TurnContent =
  | { content: string; questionResponse?: never }
  | { content?: never; questionResponse: { callId: string; response: QuestionResponse } };

export type EditContent =
  | { content: string; questionResponse?: never }
  | { content?: never; questionResponse: QuestionResponse };

/**
 * What one assistant generation ran with. Resolved by the service inside the
 * turn's transaction (`resolve` receives the same handle), stored beside the
 * assistant row. New agent attempts re-resolve; plain-chat retries replay.
 */
export interface GenerationConfig {
  readonly agentId: string | null;
  readonly resolvedAgent: ResolvedAgentConfig | null;
  readonly resolvedProject?: ResolvedProject | null;
  readonly standaloneCollectionIds: ReadonlyArray<string>;
  readonly collectionIds: ReadonlyArray<string>;
  readonly standaloneSkillIds?: ReadonlyArray<string>;
  readonly skills?: ReadonlyArray<import("~/modules/skills/schema.ts").SkillManifestEntry>;
  readonly manifest: ReadonlyArray<ManifestEntry>;
  readonly knowledgeMode: "none" | "context" | "retrieval";
  readonly searchEnabled: boolean;
  /** Whether `deep_research` was offered; the model still chooses. */
  readonly researchEnabled: boolean;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly planEnabled: boolean;
  /**
   * Names when this attempt could reach a machine; null when it could not.
   * Names alone persist: the paths stay on the machine that granted them and
   * reach the model only through attempt-scoped prompt text and tool traffic.
   */
  readonly desktopFolders?: ReadonlyArray<string> | null;
  /** Whether that machine could sandbox a command at the time. */
  readonly desktopCommands?: boolean;
  readonly desktopBrowser?: boolean;
  /** The machine the attempt was sent from; null predates machine stamping. */
  readonly desktopMachineId?: string | null;
  readonly desktopMachineName?: string | null;
  /** Workspace files this turn's send claimed; empty for every other attempt. */
  readonly workspaceFiles?: ReadonlyArray<string>;
  /** A schedule fire's up-front integration consent; null with a person present. */
  readonly integrationGrants?: ReadonlyArray<IntegrationGrant> | null;
}
export interface DraftSummary {
  id: string;
  name: string;
  messageId: string;
}
const draftSummary = (draft: {
  id: string;
  settings: unknown;
  messageId: string;
}): DraftSummary => ({
  id: draft.id,
  name: (draft.settings as { name?: string }).name ?? "",
  messageId: draft.messageId,
});

/**
 * A message row that sorts before `id` in the conversation's total order
 * `(created_at, id)`. Compared in SQL: a JS Date drops the microseconds that
 * tell apart the rows of one turn.
 */
/**
 * A branch's tool rows name its own copies of the files they delivered, so a
 * file card still groups under the call that produced it there.
 */
const withClonedFileIds = (
  toolName: string,
  result: JsonValue | null,
  cloned: ReadonlyMap<string, string>,
): JsonValue | null => {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const copy = (id: string) => {
    const cloneId = cloned.get(id);
    return cloneId ? [cloneId] : [];
  };
  // Both deliver a file under the same activity shape; a copy points at the branch's own.
  if (toolName === "publish_file" || toolName === "create_file") {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(ToolFileActivity)(result));
    if (stored?.attachmentId) {
      const next = { ...result };
      delete next.attachmentId;
      const [id] = copy(stored.attachmentId);
      return id ? { ...next, attachmentId: id } : next;
    }
  }
  if (isCustomToolName(toolName)) {
    const stored = Option.getOrUndefined(Schema.decodeUnknownOption(CustomToolActivity)(result));
    if (stored?.fileIds) return { ...result, fileIds: stored.fileIds.flatMap(copy) };
  }
  return result;
};

const positionBefore = (id: string) =>
  sql`(${messages.createdAt}, ${messages.id}) < (select position.created_at, position.id from ${messages} as position where position.id = ${id})`;

/** Chats a list may show: never temporary, never archived. */
const listedBy = (userId: string) =>
  and(
    eq(conversations.userId, userId),
    eq(conversations.temporary, false),
    isNull(conversations.archivedAt),
  );

/** Chats search may find: archived ones too, marked, never temporary. */
const searchableBy = (userId: string) =>
  and(eq(conversations.userId, userId), eq(conversations.temporary, false));

/** The fixed association, not an agent configuration snapshot. */
export interface ConversationDefaults {
  readonly agent: { agentId: string | null } | null;
  /** The chat's project, re-authorized by every attempt; null outside one. */
  readonly projectId?: string | null;
  /** Fixed at creation. Read by the resolver, which refuses a work send without a folder. */
  readonly mode?: "chat" | "work";
  /**
   * Every draft this conversation owns, oldest first. Names are already public;
   * the creating answer lets a rewind confirmation name what it removes.
   */
  readonly agentDrafts?: ReadonlyArray<DraftSummary>;
  /** Schedule drafts the conversation owns, discovered the same way. */
  readonly scheduleDrafts?: ReadonlyArray<DraftSummary>;
  /** Mutable chat documents stay out of history; the loader carries summaries only. */
  readonly documents?: ReadonlyArray<{ id: string; title: string; messageId: string | null }>;
  /** Unpublished working files kept for later answers, named so a rewind can say it removes them. */
  readonly workingFiles?: ReadonlyArray<{ id: string; name: string; messageId: string }>;
}
export type ResolveError =
  | AgentNotAvailable
  | WorkDesktopRequired
  | SkillNotAvailable
  | SkillRejected
  | KnowledgeNotAvailable
  | KnowledgeRejected
  | InvalidMessage;
export type ResolveGeneration = (
  tx: DbTx,
  defaults: ConversationDefaults,
  continuation?: GenerationConfig,
) => Effect.Effect<GenerationConfig, ResolveError>;
/** An ordinary generation: no agent, no knowledge, no plan. */
export const PLAIN_GENERATION: GenerationConfig = {
  agentId: null,
  resolvedAgent: null,
  standaloneCollectionIds: [],
  collectionIds: [],
  manifest: [],
  knowledgeMode: "none",
  searchEnabled: false,
  researchEnabled: false,
  reasoningEffort: null,
  planEnabled: false,
};

/** Everything about a turn except its content; `CreateTurnInput` adds that. */
export type ConversationReference =
  | {
      readonly kind: "new";
      readonly id: string;
      readonly mode: "chat" | "work";
      readonly temporary?: boolean | undefined;
      readonly projectId?: string | undefined;
    }
  | { readonly kind: "existing"; readonly id: string };

export type TurnFields = {
  userId: string;
  conversation: ConversationReference;
  /** Present only when a reserved file-bearing Work send activates. */
  reservationId?: string | undefined;
  modelId: string;
  attachmentIds: ReadonlyArray<string>;
  /** Installs only the association on a new conversation, after live resolution. */
  associateAgentId?: string | undefined;
  /**
   * Set only when a schedule fires this turn into a brand-new conversation;
   * links the chat back to the schedule that started it.
   */
  scheduleId?: string | undefined;
  /** A pending scheduled attempt, bound to this turn inside its transaction. */
  scheduleRunId?: string | undefined;
  /** Standalone collections selected for this message only. */
  collectionIds?: ReadonlyArray<string> | undefined;
  skillIds?: ReadonlyArray<string> | undefined;
  /** Absent means a plain generation; the service always supplies one. */
  resolve?: ResolveGeneration | undefined;
};
export type CreateTurnInput = TurnFields & TurnContent;
export type WorkTurnReservationRow = typeof workTurnReservations.$inferSelect;

export type QueueEntry = typeof conversationQueueEntries.$inferSelect;
/** A queue row with its files, as the queue strip and dispatch read it. */
export type QueuedMessage = QueueEntry & { attachments: ReadonlyArray<Attachment> };
/** How many messages may wait behind one answer. */
export const QUEUE_LIMIT = 10;

export type ConversationRow = typeof conversations.$inferSelect;
/** A list row plus the live state the list surfaces (sidebar spinner). */
/** One chat found by search; `messageId` and `snippet` are set when message text matched. */
export interface ChatSearchHit {
  conversationId: string;
  title: string | null;
  messageId: string | null;
  snippet: Snippet | null;
  archived: boolean;
}

/**
 * Must repeat `messages_search_idx` exactly (`src/db/schema/chat.ts`), or
 * Postgres cannot use the index and scans every message.
 */
const messageSearchVector = (content: SQLWrapper) =>
  sql`to_tsvector('app_search'::regconfig, ${content})`;

/**
 * How far the recent window reaches before falling back to the index: chats,
 * then messages back from each chat's newest. A frequent term that only
 * appears further back in a long, recent chat can lose to ones found here.
 */
const SEARCH_WINDOW_CHATS = 40;
const SEARCH_WINDOW_MESSAGES = 200;

/** Citation markers and markdown emphasis, which read as noise in an excerpt. */
const HEADLINE_NOISE = "\\[\\^[0-9]+\\]|[*#`]+";
const HEADLINE_OPTIONS = `StartSel=${HIGHLIGHT_START}, StopSel=${HIGHLIGHT_END}, MaxWords=24, MinWords=12`;

export type ConversationListRow = ConversationRow & {
  generating: boolean;
  /** Created by a schedule, or the chat a schedule keeps running in. */
  scheduled: boolean;
};
/** Position in the conversation list order: activity timestamp, then id. */
export interface ConversationCursor {
  readonly activity: Date;
  readonly id: string;
}
type StoredMessage = typeof messages.$inferSelect;
export type MessageRow = Omit<
  StoredMessage,
  "generationId" | "assistantOutput" | "providerReplay"
> &
  Partial<Pick<StoredMessage, "generationId" | "assistantOutput" | "providerReplay">>;
export type HistorySnapshot = ReadonlyArray<
  Pick<
    MessageRow,
    | "id"
    | "status"
    | "content"
    | "questionResponse"
    | "editedAt"
    | "completedAt"
    | "generationId"
    | "assistantOutput"
    | "providerReplay"
  >
>;

const matchesHistory = (actual: HistorySnapshot, expected: HistorySnapshot): boolean =>
  actual.length === expected.length &&
  actual.every((message, index) => {
    const previous = expected[index]!;
    return (
      message.id === previous.id &&
      message.status === previous.status &&
      message.generationId === previous.generationId &&
      JSON.stringify(message.assistantOutput) === JSON.stringify(previous.assistantOutput) &&
      JSON.stringify(message.providerReplay) === JSON.stringify(previous.providerReplay) &&
      message.content === previous.content &&
      JSON.stringify(message.questionResponse) === JSON.stringify(previous.questionResponse) &&
      message.editedAt?.getTime() === previous.editedAt?.getTime() &&
      message.completedAt?.getTime() === previous.completedAt?.getTime()
    );
  });
// How long a streaming row may go without a heartbeat before it is treated as
// abandoned. Flushes run every 250ms, so this survives a slow provider call
// and a busy event loop but not a dead process.
const GENERATION_LEASE = sql`interval '45 seconds'`;
// Granted whenever a row enters "streaming", so a retry of an old row is not
// judged by its original creation time. Renewed by every flush afterwards.
const freshLease = () => sql`clock_timestamp() + ${GENERATION_LEASE}`;
export const INTERRUPTED_MESSAGE = "The response was interrupted before it finished.";

export type ChunkKind = "text" | "reasoning" | "tool" | "compaction" | "file" | "steer" | "writing";
export type ChunkRow = { seq: number; kind: ChunkKind; delta: string };
/** A persisted chunk with the time it was written, which a replay reports as its own. */
export type StoredChunk = ChunkRow & { createdAt: Date };
/**
 * Durable tool-call projection safe for clients (summaries only, no page bodies).
 */
export type UiStateRow = typeof messageUiStates.$inferSelect;
export type ToolCallRow = typeof messageToolCalls.$inferSelect;
export type CompactionCheckpointRow = typeof conversationCompactionCheckpoints.$inferSelect;
export type CompactionEventRow = typeof messageCompactionEvents.$inferSelect;

// `%`, `_` and the escape character itself are literals when someone types
// them into a search box, not wildcards.

// Callers hold the conversation lock. Only one successful immutable batch can
// own the immediately following structured user response.
/**
 * A conversation's turns without the steers inside them. A steer sorts just
 * after the answer it went into, so anything asking "what came last" (the
 * question a reply answers, whether the queue may start) reads through this.
 */
const turnMessagesOf = (conversationId: string) =>
  and(eq(messages.conversationId, conversationId), isNull(messages.steeredIntoMessageId));

/**
 * Whether a conversation's queue may move, read the one way promotion and the
 * queue strip both use, so what the strip says is what promotion will do.
 */
const readQueueGate = Effect.fn("ChatRepo.readQueueGate")(function* (
  tx: Pick<DbTx, "select">,
  conversationId: string,
) {
  const streaming = yield* tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "streaming")))
    .pipe(Effect.orDie);
  if (streaming.length > 0) return "busy" as const;
  const [tail] = yield* tx
    .select()
    .from(messages)
    .where(turnMessagesOf(conversationId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1)
    .pipe(Effect.orDie);
  // A stopped or failed answer ends automatic progress: the person stopped
  // this conversation, not just one response.
  if (tail?.role !== "assistant" || tail.status !== "complete") return "unsettled" as const;
  // An unanswered clarification owns the next turn; a queued message must
  // never race the structured answer.
  if (yield* questionForMessage(tx, tail)) return "question" as const;
  return "open" as const;
});
export type QueueGate = Effect.Success<ReturnType<typeof readQueueGate>>;

/**
 * The order entries start in. A steered entry comes first: it was asked to go
 * now, and one whose answer ended before a boundary goes as the next turn
 * instead, ahead of older queued messages. Its steer fields keep naming that
 * attempt; the claim matches the live generation, so no later one takes it.
 */
const queueOrder = [
  sql`${conversationQueueEntries.steerMessageId} is null`,
  asc(conversationQueueEntries.id),
] as const;

/** The queue's one lock: every queue write serializes on its conversation. */
const lockOwnedConversation = (tx: DbTx, userId: string, conversationId: string) =>
  Effect.gen(function* () {
    const owned = yield* tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .for("update")
      .pipe(Effect.orDie);
    if (owned.length === 0) return yield* new ConversationNotFound({ conversationId });
  });

const questionForMessage = Effect.fn("ChatRepo.questionForMessage")(function* (
  tx: Pick<DbTx, "select">,
  owner: MessageRow | undefined,
) {
  if (owner?.role !== "assistant" || owner.status !== "complete") return null;
  const calls = yield* tx
    .select()
    .from(messageToolCalls)
    .where(
      and(
        eq(messageToolCalls.messageId, owner.id),
        eq(messageToolCalls.toolName, "ask_user"),
        eq(messageToolCalls.status, "complete"),
      ),
    )
    .pipe(Effect.orDie);
  const presented = calls.flatMap((call) => {
    const questions = readPresentedQuestions(call.result);
    return questions ? [{ call, questions }] : [];
  });
  if (presented.length !== 1) return null;
  const batch = presented[0]!;
  if (
    !readStoredQuestionPresentation(batch.call.arguments, batch.call.result) ||
    extractUserUrls(
      batch.questions.flatMap((question) => question.options.map((option) => option.label)),
    ).length > 0
  )
    return null;
  return batch;
});

const questionContent = (questions: AskUserParams["questions"], response: QuestionResponse) => {
  const decoded = Schema.decodeUnknownOption(QuestionResponse)(response);
  const content = Option.isSome(decoded) ? formatQuestionResponse(questions, decoded.value) : null;
  return content === null || Option.isNone(decoded)
    ? Effect.fail(
        new InvalidMessage({
          reason: "Answer every question with valid selections or custom text.",
        }),
      )
    : Effect.succeed({ content, questionResponse: { v: 1, response: decoded.value } as JsonValue });
};

const editedContent = Effect.fn("ChatRepo.editedContent")(function* (
  tx: DbTx,
  current: ReadonlyArray<MessageRow>,
  messageId: string,
  input: EditContent & { attachmentIds: ReadonlyArray<string> },
) {
  const index = current.findIndex((message) => message.id === messageId);
  const target = current[index];
  if (target?.role !== "user" || target.status !== "complete")
    return yield* new InvalidMessage({ reason: "Only completed user messages can be edited." });
  const previousResponse = readQuestionResponse(target.questionResponse);
  // The answer it replied to, past any steers that answer took in.
  let before = index - 1;
  while (current[before]?.steeredIntoMessageId) before -= 1;
  const batch = previousResponse ? yield* questionForMessage(tx, current[before]) : null;
  const attached = previousResponse
    ? yield* tx
        .select({ id: messageAttachments.attachmentId })
        .from(messageAttachments)
        .where(eq(messageAttachments.messageId, messageId))
        .limit(1)
        .pipe(Effect.orDie)
    : [];
  const structured =
    previousResponse &&
    batch &&
    attached.length === 0 &&
    formatQuestionResponse(batch.questions, previousResponse) === target.content;
  if (input.questionResponse) {
    if (!structured || !batch || input.attachmentIds.length > 0)
      return yield* new InvalidMessage({
        reason: "These answers can no longer be edited as a question response.",
      });
    return yield* questionContent(batch.questions, input.questionResponse);
  }
  if (structured)
    return yield* new InvalidMessage({
      reason: "Use Edit answers to change a structured question response.",
    });
  return { content: input.content, questionResponse: null };
});

// ---------------------------------------------------------- generation config

const toConfig = (
  row: typeof messageGenerationConfig.$inferSelect,
  manifest: ReadonlyArray<typeof messageKnowledgeVersions.$inferSelect>,
): GenerationConfig => ({
  agentId: row.agentId,
  resolvedAgent: row.resolvedAgent,
  resolvedProject: row.resolvedProject,
  standaloneCollectionIds: row.standaloneCollectionIds,
  collectionIds: row.collectionIds,
  standaloneSkillIds: row.standaloneSkillIds,
  skills: row.skills,
  manifest: manifest.map((entry) => ({
    collectionId: entry.collectionId,
    documentId: entry.documentId,
    versionId: entry.versionId,
    title: entry.title,
    status: entry.status,
    charCount: entry.charCount,
    truncated: entry.truncated,
  })),
  knowledgeMode: row.knowledgeMode,
  searchEnabled: row.searchEnabled,
  researchEnabled: row.researchEnabled,
  reasoningEffort: row.reasoningEffort,
  planEnabled: row.planEnabled,
  desktopFolders: row.desktopFolders,
  desktopCommands: row.desktopCommands,
  desktopBrowser: row.desktopBrowser,
  desktopMachineId: row.desktopMachineId,
  desktopMachineName: row.desktopMachineName,
  workspaceFiles: row.workspaceFiles,
  integrationGrants: row.integrationGrants,
});

const readDefaults = Effect.fn("chat.readDefaults")(function* (
  tx: Pick<DbTx, "select">,
  conversationId: string,
) {
  const [agent] = yield* tx
    .select()
    .from(conversationAgents)
    .where(eq(conversationAgents.conversationId, conversationId))
    .pipe(Effect.orDie);
  const drafts = yield* tx
    .select({
      id: conversationDrafts.id,
      kind: conversationDrafts.kind,
      settings: conversationDrafts.settings,
      messageId: conversationDrafts.createdByMessageId,
    })
    .from(conversationDrafts)
    .where(eq(conversationDrafts.conversationId, conversationId))
    .orderBy(asc(conversationDrafts.id))
    .pipe(Effect.orDie);
  const documentRows = yield* tx
    .select({
      id: documents.id,
      title: documents.title,
      // The answer it belongs to, so the transcript can place a card whose
      // creating tool row a rewind took with it. Never any content.
      messageId: documents.createdByMessageId,
    })
    .from(documents)
    .where(eq(documents.conversationId, conversationId))
    .orderBy(asc(documents.id))
    .pipe(Effect.orDie);
  const workingFiles = (yield* readKeptWorkingFiles(tx, conversationId)).map((file) => ({
    id: file.latest.workingFileId,
    name: file.latest.name,
    messageId: file.createdBy,
  }));
  const [conversation] = yield* tx
    .select({ mode: conversations.mode, projectId: conversations.projectId })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .pipe(Effect.orDie);
  return {
    agent: agent ? { agentId: agent.agentId } : null,
    agentDrafts: drafts.filter((draft) => draft.kind === "agent").map(draftSummary),
    scheduleDrafts: drafts.filter((draft) => draft.kind === "schedule").map(draftSummary),
    documents: documentRows,
    workingFiles,
    mode: conversation?.mode ?? "chat",
    projectId: conversation?.projectId ?? null,
  } satisfies ConversationDefaults;
});

/** Internal plain-chat helpers may omit a resolver; agent attempts never may. */
const resolveAttempt = (
  tx: DbTx,
  defaults: ConversationDefaults,
  resolve: ResolveGeneration | undefined,
  previous?: GenerationConfig,
): Effect.Effect<GenerationConfig, ResolveError> => {
  if (resolve) return resolve(tx, defaults, previous);
  if (defaults.agent || previous?.skills?.length)
    return Effect.die(new Error("Agent and skill attempts require live configuration resolution"));
  return Effect.succeed(previous ?? PLAIN_GENERATION);
};

const readConfig = Effect.fn("chat.readGenerationConfig")(function* (
  tx: Pick<DbTx, "select">,
  messageId: string,
) {
  const [row] = yield* tx
    .select()
    .from(messageGenerationConfig)
    .where(eq(messageGenerationConfig.messageId, messageId))
    .pipe(Effect.orDie);
  if (!row)
    return yield* Effect.die(new Error(`Missing generation configuration for ${messageId}`));
  const manifest = yield* tx
    .select()
    .from(messageKnowledgeVersions)
    .where(eq(messageKnowledgeVersions.messageId, messageId))
    .orderBy(asc(messageKnowledgeVersions.position))
    .pipe(Effect.orDie);
  return toConfig(row, manifest);
});

/** Writes the effective configuration beside a freshly inserted assistant row. */
const writeConfig = Effect.fn("chat.writeGenerationConfig")(function* (
  tx: DbTx,
  messageId: string,
  config: GenerationConfig,
) {
  yield* tx
    .insert(messageGenerationConfig)
    .values({
      messageId,
      agentId: config.agentId,
      resolvedAgent: config.resolvedAgent,
      resolvedProject: config.resolvedProject ?? null,
      standaloneCollectionIds: [...config.standaloneCollectionIds],
      standaloneSkillIds: [...(config.standaloneSkillIds ?? [])],
      skills: [...(config.skills ?? [])],
      knowledgeMode: config.knowledgeMode,
      planEnabled: config.planEnabled,
      searchEnabled: config.searchEnabled,
      researchEnabled: config.researchEnabled,
      reasoningEffort: config.reasoningEffort,
      desktopFolders: config.desktopFolders ? [...config.desktopFolders] : null,
      desktopCommands: config.desktopCommands ?? false,
      desktopBrowser: config.desktopBrowser ?? false,
      desktopMachineId: config.desktopMachineId ?? null,
      desktopMachineName: config.desktopMachineName ?? null,
      workspaceFiles: [...(config.workspaceFiles ?? [])],
      collectionIds: [...config.collectionIds],
      integrationGrants: config.integrationGrants ? [...config.integrationGrants] : null,
    })
    .pipe(Effect.orDie);
  yield* tx.delete(messageSkills).where(eq(messageSkills.messageId, messageId)).pipe(Effect.orDie);
  if (config.skills?.length)
    yield* tx
      .insert(messageSkills)
      .values(
        config.skills.map((entry, position) => ({
          messageId,
          skillId: entry.skillId,
          revisionId: entry.revisionId,
          explicit: entry.explicit,
          position,
        })),
      )
      .pipe(Effect.orDie);
  if (config.manifest.length > 0)
    yield* tx
      .insert(messageKnowledgeVersions)
      .values(
        config.manifest.map((entry, position) => ({
          messageId,
          versionId: entry.versionId,
          documentId: entry.documentId,
          collectionId: entry.collectionId,
          title: entry.title,
          status: entry.status,
          charCount: entry.charCount,
          truncated: entry.truncated,
          position,
        })),
      )
      .pipe(Effect.orDie);
});

/** An answer's text or reasoning as its chunks spell it, the way the reaper reads it. */
export const joinChunks = (
  chunks: ReadonlyArray<{ kind: string; delta: string }>,
  kind: "text" | "reasoning",
) =>
  chunks
    .filter((chunk) => chunk.kind === kind)
    .map((chunk) => chunk.delta)
    .join("");

const lockWorkTurn = (tx: DbTx, conversationId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${conversationId}, 94731))`);
const expireWorkTurns = (tx: DbTx) =>
  tx
    .update(workTurnReservations)
    .set({ status: "expired", updatedAt: sql`now()` })
    .where(
      and(
        eq(workTurnReservations.status, "reserved"),
        sql`${workTurnReservations.expiresAt} <= now()`,
      ),
    );
const rejectReservedWorkTurn = (tx: DbTx, conversationId: string) =>
  Effect.gen(function* () {
    yield* lockWorkTurn(tx, conversationId).pipe(Effect.orDie);
    yield* expireWorkTurns(tx).pipe(Effect.orDie);
    const live = yield* tx
      .select({ id: workTurnReservations.id })
      .from(workTurnReservations)
      .where(
        and(
          eq(workTurnReservations.conversationId, conversationId),
          eq(workTurnReservations.status, "reserved"),
        ),
      )
      .limit(1)
      .pipe(Effect.orDie);
    if (live.length > 0) return yield* new ConversationBusy({ conversationId });
  });

/** A branch's copy of an answer's image results, pointing at the cloned attachments. */
const remapUiImages = (images: UiImages, attachmentIds: ReadonlyMap<string, string>): UiImages =>
  Object.fromEntries(
    Object.entries(images).map(([query, result]) => [
      query,
      {
        ...result,
        items: result.items.flatMap((item) => {
          const id = attachmentIds.get(item.attachmentId);
          return id ? [{ ...item, attachmentId: id }] : [];
        }),
      },
    ]),
  );

export class ChatRepo extends Context.Service<
  ChatRepo,
  {
    research?: ResearchStore;
    saveProviderReplay(
      messageId: string,
      replay: NonNullable<MessageRow["providerReplay"]>,
    ): Effect.Effect<void>;
    /**
     * One page of a user's conversations, newest activity first. Ordered by
     * `coalesce(lastMessageAt, createdAt)` with `id` as a tiebreaker so the
     * order is total, so the cursor rides on exactly that pair.
     */
    listConversations(input: {
      userId: string;
      limit: number;
      /** Last row of the previous page; omit for the first one. */
      cursor?: ConversationCursor | undefined;
      /** Case-insensitive substring match on the title; blank matches all. */
      query?: string | undefined;
      /** Leaves out chats in a project, which the sidebar lists under it. */
      outsideProjects?: boolean | undefined;
    }): Effect.Effect<{
      conversations: ConversationListRow[];
      nextCursor: ConversationCursor | null;
    }>;
    /**
     * The user's chats whose title or message text matches, most recent first
     * with title matches ahead. Each carries its newest matching message and
     * an excerpt of it.
     */
    searchConversations(input: {
      userId: string;
      query: string;
      limit: number;
    }): Effect.Effect<ChatSearchHit[]>;
    getConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ConversationRow, ConversationNotFound>;
    createConversation(input: { userId: string; modelId: string }): Effect.Effect<ConversationRow>;
    reserveWorkTurn(input: {
      id: string;
      userId: string;
      conversation: ConversationReference;
    }): Effect.Effect<
      WorkTurnReservationRow,
      ConversationNotFound | ConversationBusy | InvalidMessage
    >;
    getWorkTurnReservation(
      userId: string,
      reservationId: string,
    ): Effect.Effect<WorkTurnReservationRow, ConversationNotFound>;
    abortWorkTurn(userId: string, reservationId: string): Effect.Effect<void>;
    /**
     * One atomic turn: resolve (or create) the conversation, write the user
     * message, claim its attachments, and open the assistant row. Claiming has
     * to share the transaction, since an attachment another tab grabbed first must
     * take the whole turn down rather than leave a half-written one.
     */
    createTurn(input: CreateTurnInput): Effect.Effect<
      {
        conversation: ConversationRow;
        conversationCreated: boolean;
        userMessage: MessageRow;
        assistant: MessageRow;
        config: GenerationConfig;
        /** False when an activation retry returned the already-created turn. */
        activatedNow: boolean;
      },
      | ResolveError
      | ConversationNotFound
      | ConversationBusy
      | AttachmentNotAvailable
      | QuestionUnavailable
    >;
    /** The fixed agent association; absent for an ordinary chat. */
    /**
     * Starts the oldest queued entry, consuming it in the same transaction that
     * opens the turn. Promotion and an ordinary send therefore contend for one
     * conversation lock: whichever commits first wins, and a duplicate attempt
     * finds the entry gone rather than writing a second turn.
     */
    promoteNextQueuedTurn(input: {
      conversationId: string;
      /**
       * The head the caller validated. A removal or edit can change it before
       * the lock is taken; the promotion then reports `changed` rather than
       * starting an entry nobody checked.
       */
      expectedEntryId: string;
      /**
       * Start that entry even if it is not first: a person pressed Send now
       * on it. Otherwise only the head starts.
       */
      jumpQueue?: boolean | undefined;
      resolve: (entry: QueueEntry) => ResolveGeneration;
      /** A person asking explicitly may start after a stop or a failure. */
      force?: boolean | undefined;
    }): Effect.Effect<
      | { promoted: false; reason: "busy" | "unsettled" | "question" | "empty" | "changed" }
      | {
          promoted: true;
          entry: QueueEntry;
          conversation: ConversationRow;
          userMessage: MessageRow;
          assistant: MessageRow;
          config: GenerationConfig;
        },
      ResolveError
    >;
    /**
     * Conversations holding queued work, no live generation, and a tail that
     * finished cleanly: the ones a dispatch could start. A pre-filter only;
     * the promotion transaction still decides.
     */
    listQueuedConversations(input: {
      limit: number;
      mode: "chat" | "work";
      userId?: string | undefined;
    }): Effect.Effect<Array<{ userId: string; conversationId: string }>>;
    setQueueEntryError(entryId: string, message: string | null): Effect.Effect<void>;
    listQueue(conversationId: string): Effect.Effect<QueuedMessage[]>;
    /** See `readQueueGate`: whether the queue may move right now, and if not, why. */
    queueGate(conversationId: string): Effect.Effect<QueueGate>;
    enqueue(input: {
      userId: string;
      conversationId: string;
      content: string;
      input: QueuedTurnInput;
      attachmentIds: ReadonlyArray<string>;
    }): Effect.Effect<QueueEntry, ConversationNotFound | QueueFull | AttachmentNotAvailable>;
    /**
     * Rewrites a queued message in place, keeping its id and so its position.
     * Its files are reconciled like an edited message's; a pending steer is
     * dropped, since it was aimed at the words being replaced. Returns cleanup
     * keys for files the edit let go.
     */
    replaceQueueEntry(input: {
      userId: string;
      conversationId: string;
      entryId: string;
      content: string;
      input: QueuedTurnInput;
      attachmentIds: ReadonlyArray<string>;
    }): Effect.Effect<
      ReadonlyArray<string>,
      ConversationNotFound | QueueEntryNotFound | AttachmentNotAvailable
    >;
    /** Returns cleanup keys: removing a queued message deletes its files. */
    removeQueueEntry(input: {
      userId: string;
      conversationId: string;
      entryId: string;
    }): Effect.Effect<ReadonlyArray<string>, ConversationNotFound>;
    steerQueueEntry(input: {
      userId: string;
      conversationId: string;
      entryId: string;
      messageId: string;
      generationId: string;
    }): Effect.Effect<void, ConversationNotFound | QueueEntryNotFound | NoActiveGeneration>;
    /**
     * Inside the running generation, under its fence: turns every entry aimed
     * at it into a user message, in queue order, moving its files along.
     */
    claimSteeredEntries(input: {
      conversationId: string;
      messageId: string;
      /** The answer's text length at the boundary, where the steer renders. */
      textOffset: number;
      /** The model round the steer followed. */
      turnIndex: number;
    }): Effect.Effect<Array<MessageRow & { queueEntryId: string }>>;
    getConversationDefaults(conversationId: string): Effect.Effect<ConversationDefaults>;
    /**
     * Private attempt execution record. Missing rows are an invariant violation;
     * no configuration is inferred from history or old tool calls.
     */
    getGenerationConfig(messageId: string): Effect.Effect<GenerationConfig>;
    /**
     * One display field for the prompt builder: the workspace files each of
     * these attempts claimed. Missing rows (a system message, a pre-migration
     * row) map to none; the line is additive, never load-bearing.
     */
    listWorkspaceFilesByMessage(
      messageIds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
    listGenerationDisplay(messageIds: ReadonlyArray<string>): Effect.Effect<
      Array<{
        messageId: string;
        collectionIds: ReadonlyArray<string>;
        skills?: ReadonlyArray<{ id: string; name: string }>;
        /**
         * The machine this attempt was sent from, when it was. The banner
         * compares the latest answer's stamp with the local machine id.
         */
        desktopMachine?: { id: string; name: string | null } | null;
        /** Workspace files the turn's send claimed; shown as chips on the question. */
        workspaceFiles: ReadonlyArray<string>;
        /**
         * The attempt's roots, names only. The display layer prefixes them with
         * the machine's current workspace path, so delete lists group by owner
         * without the server ever storing one.
         */
        desktopRoots?: ReadonlyArray<string>;
      }>
    >;
    updateConversation(
      conversationId: string,
      patch: Partial<{
        title: string;
        modelId: string;
        lastMessageAt: Date;
        permissionLevel: "manual" | "auto" | "skip";
      }>,
    ): Effect.Effect<void>;
    /** Clears the temporary flag. False when it was already a kept chat. */
    keepConversation(userId: string, conversationId: string): Effect.Effect<boolean>;
    /**
     * Archives or unarchives one chat. False when nothing changed: already in
     * that state, not this person's, or temporary (which is never archived).
     */
    setArchived(userId: string, conversationId: string, archived: boolean): Effect.Effect<boolean>;
    /** Archives every chat a list shows; returns the ids it archived. */
    archiveAll(userId: string): Effect.Effect<ReadonlyArray<string>>;
    /** Archived chats, most recently archived first. */
    listArchived(
      userId: string,
    ): Effect.Effect<ReadonlyArray<{ id: string; title: string | null; archivedAt: Date }>>;
    /**
     * Resolves a pending title. False when the row is gone or already titled,
     * since a manual rename that landed first must not be overwritten.
     */
    setTitleIfPending(conversationId: string, title: string): Effect.Effect<boolean>;
    /**
     * Returns storage keys the caller must delete after the commit.
     */
    deleteConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<string>>;
    /** Temporary chats past their lifetime with no live answer, oldest first. */
    listExpiredTemporary(limit: number): Effect.Effect<ReadonlyArray<{ id: string }>>;
    /**
     * Deletes the chat only if it is still an expired temporary one under the
     * row lock, so a Keep or a new message landing after the listing wins.
     * Null when it no longer qualifies; otherwise its owner and the storage
     * keys the caller must delete after the commit.
     */
    deleteExpiredTemporary(
      conversationId: string,
    ): Effect.Effect<{ userId: string; keys: ReadonlyArray<string> } | null>;
    /**
     * Forks the conversation into a new one carrying every message up to and
     * including `throughMessageId`. Messages, tool calls and attachment links
     * are copied; stream chunks are not (they only serve live resume). One
     * transaction, so a half-copied branch can never be observed.
     */
    cloneConversationPrefix(input: {
      userId: string;
      sourceConversationId: string;
      throughMessageId: string;
    }): Effect.Effect<
      ConversationRow,
      ConversationNotFound | MessageNotFound | BranchNotAllowed | ConversationBusy
    >;
    listMessages(conversationId: string): Effect.Effect<MessageRow[]>;
    /**
     * The message opening the last `turns` turns before `beforeId`, or before
     * the end. Null when fewer turns exist, so the window reaches the start.
     */
    findWindowStart(
      conversationId: string,
      turns: number,
      beforeId?: string,
    ): Effect.Effect<string | null>;
    /** Messages from `fromId` (or the start) up to, not including, `beforeId` (or the end). */
    listMessageWindow(
      conversationId: string,
      range: { fromId?: string | null; beforeId?: string },
    ): Effect.Effect<MessageRow[]>;
    hasMessagesBefore(conversationId: string, messageId: string): Effect.Effect<boolean>;
    hasMessage(conversationId: string, messageId: string): Effect.Effect<boolean>;
    /** The newest answer sent from a desktop machine, however far back it is. */
    latestMachineAttempt(conversationId: string): Effect.Effect<{
      messageId: string;
      desktopMachine: { id: string; name: string | null };
    } | null>;
    /** Sources earlier messages' tool calls registered under these citation numbers. */
    listSourcesBefore(
      conversationId: string,
      messageId: string,
      indexes: ReadonlyArray<number>,
    ): Effect.Effect<unknown[]>;
    insertMessage(input: {
      conversationId: string;
      role: "user" | "assistant" | "system";
      status?: "streaming" | "complete";
      content?: string;
      modelId?: string;
    }): Effect.Effect<MessageRow>;
    isDesktopAttemptLive(owner: ExternalOwner): Effect.Effect<boolean>;
    getMessage(messageId: string): Effect.Effect<MessageRow | null>;
    appendChunks(
      messageId: string,
      chunks: ReadonlyArray<{ seq: number; kind: ChunkKind; delta: string }>,
    ): Effect.Effect<void>;
    chunksAfter(messageId: string, afterSeq: number): Effect.Effect<StoredChunk[]>;
    /** The message's highest chunk seq, 0 when it has none. */
    lastChunkSeq(messageId: string): Effect.Effect<number>;
    insertToolCall(input: {
      id: string;
      messageId: string;
      turnIndex: number;
      callIndex: number;
      textOffset?: number;
      providerCallId: string;
      toolName: string;
      arguments: JsonValue;
    }): Effect.Effect<void>;
    completeToolCall(input: {
      id: string;
      result: JsonValue;
      status: "complete" | "error";
      error?: { code: string; message: string };
    }): Effect.Effect<void>;
    /**
     * Ends a call whose body was written as it ran, so the stored result stands.
     */
    settleToolCall(input: {
      id: string;
      status: "complete" | "error";
      error?: { code: string; message: string };
    }): Effect.Effect<void>;
    /**
     * Marks calls stuck in "running" as failed (crash/fatal-error cleanup).
     */
    failRunningToolCalls(messageId: string, message: string): Effect.Effect<void>;
    /** Keeps the full arguments of those calls that ended in error, for a week of debugging. */
    keepFailedCallArguments(
      calls: ReadonlyArray<{ id: string; arguments: JsonValue }>,
    ): Effect.Effect<void>;
    /** Drops failed calls' full arguments older than a week, by the database clock. */
    sweepFailedCallArguments(): Effect.Effect<number>;
    listToolCalls(messageIds: ReadonlyArray<string>): Effect.Effect<ToolCallRow[]>;
    /** Saved ```ui block state for these answers; the client drops rows whose hash no longer matches. */
    listUiStates(messageIds: ReadonlyArray<string>): Effect.Effect<UiStateRow[]>;
    /**
     * Saves one block's state for the conversation's owner. Refused unless the
     * answer is finished, still on `generationId`, and its block `ordinal`
     * hashes to `sourceHash`: a late save from a replaced attempt changes nothing.
     */
    saveUiState(input: {
      userId: string;
      messageId: string;
      generationId: string;
      ordinal: number;
      sourceHash: string;
      state: JsonValue;
    }): Effect.Effect<"saved" | "refused">;
    /**
     * Records what one ```ui image query came to, merged into the answer's
     * output under the generation fence. Returns every result so far.
     */
    recordUiImages(
      fence: GenerationIdentity,
      query: string,
      result: UiImageResult,
    ): Effect.Effect<UiImages>;
    createCompactionEvent(input: {
      id: string;
      messageId: string;
      beforeTurnIndex: number;
      passIndex: number;
      textOffset?: number;
      scope: "history" | "active_rounds";
    }): Effect.Effect<void>;
    completeCompactionEvent(input: {
      id: string;
      status: "complete" | "error";
      outcome?: "summary" | "hard_truncation";
      checkpointId?: string | null;
      summary?: string;
      error?: { code: string; message: string };
    }): Effect.Effect<void>;
    /**
     * Marks an interrupted compaction terminal alongside interrupted tools.
     */
    failRunningCompactionEvents(messageId: string, message: string): Effect.Effect<void>;
    /**
     * Renews a streaming row's lease without taking the conversation lock: the
     * generation identity sits in the WHERE clause instead, so a row a retry
     * already reclaimed matches nothing. Called between chunks, so it must not
     * queue behind the writes it is meant to outlive.
     */
    renewGenerationLease(messageId: string, generationId: string): Effect.Effect<void>;
    /**
     * Terminalizes ordinary generations whose owning process stopped renewing
     * their lease (crash, restart, HMR disposal). The row keeps what was
     * streamed. Returns the messages it settled so the caller can notify.
     */
    reapExpiredGenerations(): Effect.Effect<
      ReadonlyArray<{
        userId: string;
        conversationId: string;
        messageId: string;
        generationId: string | null;
      }>
    >;
    listCompactionEvents(messageIds: ReadonlyArray<string>): Effect.Effect<CompactionEventRow[]>;
    /** Settle a failed detached attempt and its activity in one generation-fenced write. */
    failGeneration(input: {
      messageId: string;
      error: string;
      ledger: UsageEventInput & { conversationId: string };
    }): Effect.Effect<void>;
    finalizeMessage(input: {
      ledger?: UsageEventInput & { conversationId: string };
      messageId: string;
      status: "complete" | "error" | "aborted";
      content: string;
      reasoning?: string;
      usage?: {
        inputTokens?: number;
        outputTokens?: number;
        firstInputTokens?: number;
        estimatedFirstInputTokens?: number;
      };
      error?: { tag: string; message: string };
    }): Effect.Effect<void>;
    /**
     * Claims and wipes a finished assistant back to a fresh streaming state.
     * The claim, rewind deletes, and optional user edit commit atomically.
     */
    resetMessageForRetry(input: {
      expectedMessages: HistorySnapshot;
      userId: string;
      messageId: string;
      modelId: string;
      deleteMessageIds: ReadonlyArray<string>;
      /**
       * Compaction boundaries this rewind invalidates. Deleted messages take
       * their checkpoints with them via cascade, but a retried assistant and
       * an edited user message keep their ids, so a summary ending there now
       * describes text that no longer exists and has to go explicitly.
       */
      invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
      edit?: EditContent & {
        messageId: string;
        conversationId: string;
        attachmentIds: ReadonlyArray<string>;
      };
      resolve?: ResolveGeneration | undefined;
    }): Effect.Effect<
      {
        claimed: boolean;
        orphanedKeys: ReadonlyArray<string>;
        generationId?: string | undefined;
        searchEnabled?: boolean | undefined;
      },
      AttachmentNotAvailable | ResolveError | ConversationBusy
    >;
    /**
     * Claims the conversation's last answer, failed or stopped, for a new
     * generation that continues it. Unlike retry nothing it produced is
     * removed: text, chunks, tool rows, files and drafts all stay.
     */
    resumeMessage(input: {
      userId: string;
      messageId: string;
      modelId: string;
      resolve?: ResolveGeneration | undefined;
    }): Effect.Effect<
      { claimed: false } | { claimed: true; generationId: string; searchEnabled: boolean },
      ResolveError | ConversationBusy
    >;
    createAssistantForEdit(
      input: EditContent & {
        expectedMessages: HistorySnapshot;
        userId: string;
        conversationId: string;
        userMessageId: string;
        expectedEditedAt: Date | null;
        attachmentIds: ReadonlyArray<string>;
        modelId: string;
        deleteMessageIds: ReadonlyArray<string>;
        /** See resetMessageForRetry. */
        invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
        /** The new answer is a new generation: it resolves against the conversation defaults. */
        resolve?: ResolveGeneration | undefined;
      },
    ): Effect.Effect<
      { message: MessageRow; orphanedKeys: ReadonlyArray<string>; config: GenerationConfig } | null,
      ResolveError | AttachmentNotAvailable | ConversationBusy
    >;
    /**
     * Removes messages entirely (chunks/tool calls go via FK cascade).
     * Returns storage keys to delete after the commit.
     */
    deleteMessages(messageIds: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>>;
    /**
     * Every compaction checkpoint of a conversation, oldest first. Superseded
     * rows are kept, so the caller picks the newest whose boundary is still a
     * position in the message list it is looking at (see `compaction.ts`).
     */
    listCompactionCheckpoints(
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<CompactionCheckpointRow>>;
    /**
     * Records a summary covering everything through `throughMessageId`. Takes
     * the conversation lock first so a concurrent branch clone sees either all
     * of this checkpoint or none of it.
     */
    insertCompactionCheckpoint(input: {
      conversationId: string;
      throughMessageId: string;
      modelId: string | null;
      summary: string;
    }): Effect.Effect<CompactionCheckpointRow | null>;
  }
>()("chat/chat/ChatRepo") {
  static readonly layer = Layer.effect(
    ChatRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const attachments = yield* AttachmentRepo;
      const research = createResearchStore(db);
      const generationWrite = <A, E, R>(run: (tx: DbTx) => Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          const fence = yield* GenerationFence;
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (fence) yield* lockGeneration(tx, fence);
                return yield* run(tx);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        });

      /**
       * A temporary chat a day past its last activity, judged by the database
       * clock. One with an answer still inside its lease is left for the next
       * pass rather than deleted from under the generation.
       */
      const expiredTemporary = and(
        eq(conversations.temporary, true),
        sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) < now() - make_interval(hours => ${TEMPORARY_CHAT_HOURS})`,
        sql`not exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.status} = 'streaming' and ${messages.generationLeaseUntil} > now())`,
      );

      /**
       * Deletes one conversation if `condition` still holds under its row
       * lock. The condition gates everything below, not just the final
       * delete: the attachment release must never run for a conversation the
       * caller does not own.
       */
      const deleteLocked = (conversationId: string, condition: SQL | undefined) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              const [owned] = yield* tx
                .select({ userId: conversations.userId })
                .from(conversations)
                .where(and(eq(conversations.id, conversationId), condition))
                .for("update");
              if (!owned) return null;
              yield* research.finalizeBeforeDelete(tx, conversationId);

              const rows = yield* tx
                .select({ id: messages.id })
                .from(messages)
                .where(eq(messages.conversationId, conversationId));
              // Both link tables cascade, but the attachment rows they
              // point at do not, so release them explicitly. Queued
              // messages hold files too, and nothing else would free them
              // before the 24-hour sweep.
              const keys = yield* attachments.releaseForMessages(
                tx,
                rows.map((row) => row.id),
              );
              const queued = yield* tx
                .select({ id: conversationQueueEntries.id })
                .from(conversationQueueEntries)
                .where(eq(conversationQueueEntries.conversationId, conversationId));
              const queuedKeys = yield* attachments.releaseForQueueEntries(
                tx,
                queued.map((row) => row.id),
              );
              yield* tx.delete(conversations).where(eq(conversations.id, conversationId));
              return { userId: owned.userId, keys: [...keys, ...queuedKeys] };
            }),
          )
          .pipe(Effect.orDie);

      /**
       * Newest matching message per chat among the user's most recent chats,
       * each checked back through its latest messages. Bounded work, and the
       * common case: a frequent term fills the page from recent chats without
       * touching every match in the history. Newest chats first.
       */
      const recentMatches = (userId: string, query: SQL, limit: number) => {
        const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
        const recent = db
          .select({
            id: conversations.id,
            title: conversations.title,
            activity: sql<string>`${activity}`.as("recent_activity"),
          })
          .from(conversations)
          .where(searchableBy(userId))
          .orderBy(desc(activity), desc(conversations.id))
          .limit(SEARCH_WINDOW_CHATS)
          .as("recent");
        const latest = db
          .select({ id: messages.id, content: messages.content })
          .from(messages)
          .where(and(sql`${messages.conversationId} = ${recent.id}`, ne(messages.role, "system")))
          .orderBy(desc(messages.createdAt), desc(messages.id))
          .limit(SEARCH_WINDOW_MESSAGES)
          .as("latest");
        const hit = db
          .select({ messageId: latest.id })
          .from(latest)
          .where(sql`${messageSearchVector(latest.content)} @@ ${query}`)
          .limit(1)
          .as("hit");
        return db
          .select({ conversationId: recent.id, title: recent.title, messageId: hit.messageId })
          .from(recent)
          .innerJoinLateral(hit, sql`true`)
          .orderBy(desc(recent.activity), desc(recent.id))
          .limit(limit)
          .pipe(Effect.orDie);
      };

      /**
       * Newest matching message per chat across the whole history, through
       * the index. Only for terms too rare to fill a page from recent chats.
       * A broad term's match list outgrows the default work_mem; Postgres then
       * rechecks whole pages and recomputes each message's vector, which is
       * seconds instead of milliseconds at a million messages.
       */
      const indexedMatches = (userId: string, query: SQL, limit: number) =>
        db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.execute(sql`set local work_mem = '64MB'`);
              const matched = tx
                .selectDistinctOn([messages.conversationId], {
                  conversationId: sql<string>`${messages.conversationId}`.as(
                    "matched_conversation_id",
                  ),
                  messageId: sql<string>`${messages.id}`.as("matched_message_id"),
                })
                .from(messages)
                .innerJoin(conversations, eq(conversations.id, messages.conversationId))
                .where(
                  and(
                    searchableBy(userId),
                    ne(messages.role, "system"),
                    sql`${messageSearchVector(messages.content)} @@ ${query}`,
                  ),
                )
                .orderBy(messages.conversationId, desc(messages.createdAt), desc(messages.id))
                .as("matched");
              return yield* tx
                .select({
                  conversationId: conversations.id,
                  title: conversations.title,
                  messageId: matched.messageId,
                })
                .from(matched)
                .innerJoin(conversations, eq(conversations.id, matched.conversationId))
                .orderBy(
                  desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`),
                  desc(conversations.id),
                )
                .limit(limit);
            }),
          )
          .pipe(Effect.orDie);

      return ChatRepo.of({
        research,
        saveProviderReplay: (messageId, replay) =>
          generationWrite((tx) =>
            tx
              .update(messages)
              .set({ providerReplay: replay })
              .where(eq(messages.id, messageId))
              .pipe(Effect.orDie, Effect.asVoid),
          ),
        listConversations: Effect.fn("ChatRepo.listConversations")(function* (input) {
          const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
          const title = input.query?.trim();
          const rows = yield* db
            .select({
              ...getTableColumns(conversations),
              // Live per-row state for the list UIs: an answer is being
              // generated iff a message row is still streaming. The sync bus
              // invalidates the list on every message.status flip, so the
              // flag turns on and off without polling.
              generating: sql<boolean>`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.status} = 'streaming')`,
              scheduled: sql<boolean>`(${conversations.scheduleId} is not null or exists (select 1 from ${schedules} where ${schedules.chatId} = ${conversations.id}))`,
            })
            .from(conversations)
            .where(
              and(
                listedBy(input.userId),
                // Keyset, not OFFSET: the list reorders whenever a message
                // lands, and an offset would then skip or repeat rows.
                input.cursor
                  ? or(
                      sql`${activity} < ${input.cursor.activity.toISOString()}::timestamptz`,
                      and(
                        sql`${activity} = ${input.cursor.activity.toISOString()}::timestamptz`,
                        lt(conversations.id, input.cursor.id),
                      ),
                    )
                  : undefined,
                // A title still being generated is null, so it matches nothing,
                // which is correct: there is not yet anything to match against.
                title ? ilike(conversations.title, `%${escapeLike(title)}%`) : undefined,
                input.outsideProjects ? isNull(conversations.projectId) : undefined,
              ),
            )
            .orderBy(desc(activity), desc(conversations.id))
            // One extra row answers "is there another page" without a count.
            .limit(input.limit + 1)
            .pipe(Effect.orDie);

          const page = rows.slice(0, input.limit);
          const last = rows.length > input.limit ? page.at(-1) : undefined;
          return {
            conversations: page,
            nextCursor: last
              ? { activity: last.lastMessageAt ?? last.createdAt, id: last.id }
              : null,
          };
        }),

        searchConversations: Effect.fn("ChatRepo.searchConversations")(function* (input) {
          const needle = input.query.trim();
          if (!needle) return [];
          const tsQuery = prefixTsQuery(needle);
          const query = sql`to_tsquery('app_search'::regconfig, ${tsQuery ?? ""})`;
          const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
          const titled = yield* db
            .select({ conversationId: conversations.id, title: conversations.title })
            .from(conversations)
            .where(
              and(
                searchableBy(input.userId),
                ilike(conversations.title, `%${escapeLike(needle)}%`),
              ),
            )
            .orderBy(desc(activity), desc(conversations.id))
            .limit(input.limit)
            .pipe(Effect.orDie);

          // Punctuation-only input has no terms, so only titles can match it;
          // titles alone may also fill the page, and they rank first anyway.
          const searchText = tsQuery !== null && titled.length < input.limit;
          const matched = searchText ? yield* recentMatches(input.userId, query, input.limit) : [];
          const found =
            searchText && matched.length < input.limit
              ? yield* indexedMatches(input.userId, query, input.limit)
              : matched;

          const titledIds = new Set(titled.map((row) => row.conversationId));
          const messageFor = new Map(found.map((row) => [row.conversationId, row.messageId]));
          const hits = [
            ...titled.map((row) => ({
              conversationId: row.conversationId,
              title: row.title,
              messageId: messageFor.get(row.conversationId) ?? null,
            })),
            ...found.filter((row) => !titledIds.has(row.conversationId)),
          ].slice(0, input.limit);

          // Excerpts only for what is returned: ts_headline re-reads the whole
          // text. Citation markers and markdown emphasis would read as noise.
          const messageIds = hits.flatMap((hit) => (hit.messageId ? [hit.messageId] : []));
          const headlines = messageIds.length
            ? yield* db
                .select({
                  id: messages.id,
                  headline: sql<string>`ts_headline('app_search'::regconfig, regexp_replace(regexp_replace(${messages.content}, ${HEADLINE_NOISE}, '', 'g'), '[[:space:]]+', ' ', 'g'), ${query}, ${HEADLINE_OPTIONS})`,
                })
                .from(messages)
                .where(inArray(messages.id, messageIds))
                .pipe(Effect.orDie)
            : [];
          const snippets = new Map(
            headlines.map((row) => [row.id, snippetFromHeadline(row.headline)] as const),
          );
          const archivedRows = hits.length
            ? yield* db
                .select({ id: conversations.id })
                .from(conversations)
                .where(
                  and(
                    inArray(
                      conversations.id,
                      hits.map((hit) => hit.conversationId),
                    ),
                    isNotNull(conversations.archivedAt),
                  ),
                )
                .pipe(Effect.orDie)
            : [];
          const archived = new Set(archivedRows.map((row) => row.id));
          return hits.map((hit) => ({
            conversationId: hit.conversationId,
            title: hit.title,
            messageId: hit.messageId,
            snippet: (hit.messageId && snippets.get(hit.messageId)) || null,
            archived: archived.has(hit.conversationId),
          }));
        }),

        getConversation: Effect.fn("ChatRepo.getConversation")(function* (userId, conversationId) {
          const rows = yield* db
            .select()
            .from(conversations)
            .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
            .pipe(Effect.orDie);
          const row = rows[0];
          if (!row) return yield* new ConversationNotFound({ conversationId });
          return row;
        }),

        createConversation: Effect.fn("ChatRepo.createConversation")(function* (input) {
          const rows = yield* db
            .insert(conversations)
            // title stays null until generation resolves it.
            .values({ id: uuidv7(), userId: input.userId, modelId: input.modelId, title: null })
            .returning()
            .pipe(Effect.orDie);
          return rows[0]!;
        }),

        reserveWorkTurn: Effect.fn("ChatRepo.reserveWorkTurn")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockWorkTurn(tx, input.conversation.id);
                yield* expireWorkTurns(tx);
                if (input.conversation.kind === "new") {
                  if (input.conversation.mode !== "work")
                    return yield* new InvalidMessage({
                      reason: "workspace files require a work chat",
                    });
                  const existing = yield* tx
                    .select({ id: conversations.id })
                    .from(conversations)
                    .where(eq(conversations.id, input.conversation.id))
                    .limit(1)
                    .pipe(Effect.orDie);
                  if (existing.length > 0)
                    return yield* new InvalidMessage({
                      reason: "the proposed conversation id already exists",
                    });
                } else {
                  const existing = yield* tx
                    .select()
                    .from(conversations)
                    .where(
                      and(
                        eq(conversations.id, input.conversation.id),
                        eq(conversations.userId, input.userId),
                      ),
                    )
                    .for("update")
                    .pipe(Effect.orDie);
                  const conversation = existing[0];
                  if (!conversation)
                    return yield* new ConversationNotFound({
                      conversationId: input.conversation.id,
                    });
                  if (conversation.mode !== "work")
                    return yield* new InvalidMessage({
                      reason: "workspace files require a work chat",
                    });
                  const streaming = yield* tx
                    .select({ id: messages.id })
                    .from(messages)
                    .where(
                      and(
                        eq(messages.conversationId, conversation.id),
                        eq(messages.status, "streaming"),
                      ),
                    )
                    .limit(1)
                    .pipe(Effect.orDie);
                  if (streaming.length > 0)
                    return yield* new ConversationBusy({ conversationId: conversation.id });
                }
                const live = yield* tx
                  .select({ id: workTurnReservations.id })
                  .from(workTurnReservations)
                  .where(
                    and(
                      eq(workTurnReservations.conversationId, input.conversation.id),
                      eq(workTurnReservations.status, "reserved"),
                    ),
                  )
                  .limit(1)
                  .pipe(Effect.orDie);
                if (live.length > 0)
                  return yield* new ConversationBusy({ conversationId: input.conversation.id });
                const rows = yield* tx
                  .insert(workTurnReservations)
                  .values({
                    id: input.id,
                    userId: input.userId,
                    conversationId: input.conversation.id,
                    intent: input.conversation.kind,
                    expiresAt: sql`now() + interval '2 minutes'`,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                return rows[0]!;
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", Effect.die),
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            );
        }),

        getWorkTurnReservation: Effect.fn("ChatRepo.getWorkTurnReservation")(
          function* (userId, reservationId) {
            yield* db
              .update(workTurnReservations)
              .set({ status: "expired", updatedAt: sql`now()` })
              .where(
                and(
                  eq(workTurnReservations.id, reservationId),
                  eq(workTurnReservations.status, "reserved"),
                  sql`${workTurnReservations.expiresAt} <= now()`,
                ),
              )
              .pipe(Effect.orDie);
            const rows = yield* db
              .select()
              .from(workTurnReservations)
              .where(
                and(
                  eq(workTurnReservations.id, reservationId),
                  eq(workTurnReservations.userId, userId),
                ),
              )
              .limit(1)
              .pipe(Effect.orDie);
            const row = rows[0];
            if (!row) return yield* new ConversationNotFound({ conversationId: reservationId });
            return row;
          },
        ),

        abortWorkTurn: Effect.fn("ChatRepo.abortWorkTurn")(function* (userId, reservationId) {
          yield* db
            .update(workTurnReservations)
            .set({ status: "aborted", updatedAt: sql`now()` })
            .where(
              and(
                eq(workTurnReservations.id, reservationId),
                eq(workTurnReservations.userId, userId),
                eq(workTurnReservations.status, "reserved"),
              ),
            )
            .pipe(Effect.orDie);
        }),

        createTurn: Effect.fn("ChatRepo.createTurn")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const conversationId = input.conversation.id;
                if (input.scheduleRunId) {
                  const [pending] = yield* tx
                    .select({ id: scheduleRuns.id, userId: schedules.userId })
                    .from(scheduleRuns)
                    .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
                    .where(
                      and(
                        eq(scheduleRuns.id, input.scheduleRunId),
                        eq(scheduleRuns.status, "pending"),
                      ),
                    )
                    .for("update", { of: scheduleRuns })
                    .pipe(Effect.orDie);
                  if (!pending || pending.userId !== input.userId)
                    return yield* new InvalidMessage({
                      reason: "the scheduled fire is no longer pending",
                    });
                }
                yield* lockWorkTurn(tx, conversationId);
                yield* expireWorkTurns(tx);
                let reservation: WorkTurnReservationRow | null = null;
                if (input.reservationId) {
                  const rows = yield* tx
                    .select()
                    .from(workTurnReservations)
                    .where(
                      and(
                        eq(workTurnReservations.id, input.reservationId),
                        eq(workTurnReservations.userId, input.userId),
                      ),
                    )
                    .for("update")
                    .pipe(Effect.orDie);
                  reservation = rows[0] ?? null;
                  if (!reservation || reservation.conversationId !== conversationId)
                    return yield* new ConversationNotFound({ conversationId });
                  if (reservation.intent !== input.conversation.kind)
                    return yield* new InvalidMessage({ reason: "the reservation intent changed" });
                  if (reservation.status === "activated" && reservation.assistantMessageId) {
                    const conversationRows = yield* tx
                      .select()
                      .from(conversations)
                      .where(
                        and(
                          eq(conversations.id, conversationId),
                          eq(conversations.userId, input.userId),
                        ),
                      )
                      .pipe(Effect.orDie);
                    const turnMessages = yield* tx
                      .select()
                      .from(messages)
                      .where(eq(messages.conversationId, conversationId))
                      .orderBy(asc(messages.createdAt), asc(messages.id))
                      .pipe(Effect.orDie);
                    const assistantIndex = turnMessages.findIndex(
                      (message) => message.id === reservation!.assistantMessageId,
                    );
                    const userMessage = turnMessages
                      .slice(0, assistantIndex)
                      .toReversed()
                      .find((message) => message.role === "user");
                    const assistant = turnMessages[assistantIndex];
                    if (!conversationRows[0] || !assistant || !userMessage)
                      return yield* Effect.die("Activated Work turn is incomplete");
                    return {
                      conversation: conversationRows[0],
                      conversationCreated: reservation.intent === "new",
                      userMessage,
                      assistant,
                      config: yield* readConfig(tx, assistant.id),
                      activatedNow: false,
                    };
                  }
                  if (reservation.status !== "reserved")
                    return yield* new ConversationBusy({ conversationId });
                } else {
                  const live = yield* tx
                    .select({ id: workTurnReservations.id })
                    .from(workTurnReservations)
                    .where(
                      and(
                        eq(workTurnReservations.conversationId, conversationId),
                        eq(workTurnReservations.status, "reserved"),
                      ),
                    )
                    .limit(1)
                    .pipe(Effect.orDie);
                  if (live.length > 0) return yield* new ConversationBusy({ conversationId });
                }

                let conversationCreated = false;
                let conversation: ConversationRow;
                if (input.conversation.kind === "existing") {
                  // FOR UPDATE serializes turns per conversation, so two
                  // concurrent sends cannot both pass the streaming check.
                  const rows = yield* tx
                    .select()
                    .from(conversations)
                    .where(
                      and(
                        eq(conversations.id, conversationId),
                        eq(conversations.userId, input.userId),
                      ),
                    )
                    .for("update")
                    .pipe(Effect.orDie);
                  const row = rows[0];
                  if (!row) return yield* new ConversationNotFound({ conversationId });
                  const streaming = yield* tx
                    .select({ id: messages.id })
                    .from(messages)
                    .where(
                      and(eq(messages.conversationId, row.id), eq(messages.status, "streaming")),
                    )
                    .pipe(Effect.orDie);
                  if (streaming.length > 0)
                    return yield* new ConversationBusy({ conversationId: row.id });
                  conversation = row;
                } else {
                  const existing = yield* tx
                    .select({ id: conversations.id })
                    .from(conversations)
                    .where(eq(conversations.id, conversationId))
                    .limit(1)
                    .pipe(Effect.orDie);
                  if (existing.length > 0)
                    return yield* new InvalidMessage({
                      reason: "the proposed conversation id already exists",
                    });
                  const rows = yield* tx
                    .insert(conversations)
                    .values({
                      id: conversationId,
                      userId: input.userId,
                      modelId: input.modelId,
                      title: null,
                      mode: input.conversation.mode,
                      temporary: input.conversation.temporary ?? false,
                      projectId: input.conversation.projectId ?? null,
                      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
                    })
                    .returning()
                    .pipe(Effect.orDie);
                  conversation = rows[0]!;
                  conversationCreated = true;
                }

                let content = input.content;
                let questionResponse: JsonValue | null = null;
                let continuation: GenerationConfig | undefined;
                if (input.questionResponse) {
                  const { callId, response } = input.questionResponse;
                  if (input.conversation.kind !== "existing" || input.attachmentIds.length > 0)
                    return yield* new QuestionUnavailable({ callId });
                  const tail = (yield* tx
                    .select()
                    .from(messages)
                    .where(turnMessagesOf(conversation.id))
                    .orderBy(desc(messages.createdAt), desc(messages.id))
                    .limit(1)
                    .pipe(Effect.orDie))[0];
                  const batch = yield* questionForMessage(tx, tail);
                  if (!batch || batch.call.id !== callId)
                    return yield* new QuestionUnavailable({ callId });
                  continuation = yield* readConfig(tx, tail!.id);
                  const formatted = yield* questionContent(batch.questions, response);
                  content = formatted.content;
                  questionResponse = formatted.questionResponse;
                }

                const userRows = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: conversation.id,
                    role: "user",
                    status: "complete",
                    content: content!,
                    questionResponse,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                const userMessage = userRows[0]!;

                yield* attachments.reconcile(tx, {
                  userId: input.userId,
                  messageId: userMessage.id,
                  attachmentIds: input.attachmentIds,
                });

                if (input.associateAgentId && !conversationCreated)
                  return yield* new InvalidMessage({
                    reason: "the agent cannot change after chat creation",
                  });
                const association = input.associateAgentId
                  ? { agentId: input.associateAgentId }
                  : null;
                const defaults: ConversationDefaults = association
                  ? {
                      agent: association,
                      mode: conversation.mode,
                      projectId: conversation.projectId,
                    }
                  : conversationCreated
                    ? { agent: null, mode: conversation.mode, projectId: conversation.projectId }
                    : yield* readDefaults(tx, conversation.id);
                const config = yield* resolveAttempt(tx, defaults, input.resolve, continuation);
                if (association)
                  yield* tx
                    .insert(conversationAgents)
                    .values({ conversationId: conversation.id, ...association })
                    .pipe(Effect.orDie);

                const assistantRows = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: conversation.id,
                    role: "assistant",
                    status: "streaming",
                    generationLeaseUntil: freshLease(),
                    modelId: input.modelId,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                yield* writeConfig(tx, assistantRows[0]!.id, config);
                if (input.scheduleRunId)
                  yield* tx
                    .update(scheduleRuns)
                    .set({ status: "started", conversationId: conversation.id })
                    .where(
                      and(
                        eq(scheduleRuns.id, input.scheduleRunId),
                        eq(scheduleRuns.status, "pending"),
                      ),
                    )
                    .pipe(Effect.orDie);
                yield* tx
                  .update(conversations)
                  .set({
                    modelId: input.modelId,
                    lastMessageAt: new Date(),
                    updatedAt: new Date(),
                    // Writing in an archived chat brings it back; a schedule's
                    // fire is nobody writing, so its chat stays put away.
                    ...(input.scheduleRunId ? {} : { archivedAt: null }),
                  })
                  .where(eq(conversations.id, conversation.id))
                  .pipe(Effect.orDie);
                if (reservation)
                  yield* tx
                    .update(workTurnReservations)
                    .set({
                      status: "activated",
                      assistantMessageId: assistantRows[0]!.id,
                      updatedAt: sql`now()`,
                    })
                    .where(eq(workTurnReservations.id, reservation.id))
                    .pipe(Effect.orDie);

                return {
                  conversation,
                  conversationCreated,
                  userMessage,
                  assistant: assistantRows[0]!,
                  config,
                  activatedNow: true,
                };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", Effect.die),
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
            );
        }),

        setQueueEntryError: Effect.fn("ChatRepo.setQueueEntryError")(function* (entryId, message) {
          yield* db
            .update(conversationQueueEntries)
            .set({ lastError: message })
            .where(eq(conversationQueueEntries.id, entryId))
            .pipe(Effect.orDie);
        }),

        listQueuedConversations: Effect.fn("ChatRepo.listQueuedConversations")(function* (input) {
          // Only conversations a dispatch could start. Question-held queues
          // and failed heads would otherwise fill the batch limit forever, and
          // a failed head would be retried and re-announced every sweep. A
          // person clears both, by answering or by editing.
          const tail = sql`(select tail.id from messages tail where tail.conversation_id = ${conversations.id} and tail.steered_into_message_id is null order by tail.created_at desc, tail.id desc limit 1)`;
          const head = sql`(select head.last_error from conversation_queue_entries head where head.conversation_id = ${conversations.id} order by head.steer_message_id is null, head.id limit 1)`;
          return yield* db
            .select({ userId: conversations.userId, conversationId: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.mode, input.mode),
                input.userId ? eq(conversations.userId, input.userId) : undefined,
                sql`exists (select 1 from conversation_queue_entries queued where queued.conversation_id = ${conversations.id})`,
                sql`exists (select 1 from messages settled where settled.id = ${tail} and settled.role = 'assistant' and settled.status = 'complete')`,
                sql`not exists (select 1 from message_tool_calls asked where asked.message_id = ${tail} and asked.tool_name = 'ask_user' and asked.status = 'complete')`,
                sql`${head} is null`,
              ),
            )
            .limit(input.limit)
            .pipe(Effect.orDie);
        }),

        promoteNextQueuedTurn: Effect.fn("ChatRepo.promoteNextQueuedTurn")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [conversation] = yield* tx
                  .select()
                  .from(conversations)
                  .where(eq(conversations.id, input.conversationId))
                  .for("update")
                  .pipe(Effect.orDie);
                if (!conversation) return { promoted: false, reason: "empty" } as const;
                const gate = yield* readQueueGate(tx, conversation.id);
                // A person asking may start after a stop, never ahead of an
                // answer still running or a question still open.
                if (gate !== "open" && !(gate === "unsettled" && input.force))
                  return { promoted: false, reason: gate } as const;
                const [entry] = yield* tx
                  .select()
                  .from(conversationQueueEntries)
                  .where(
                    and(
                      eq(conversationQueueEntries.conversationId, conversation.id),
                      input.jumpQueue
                        ? eq(conversationQueueEntries.id, input.expectedEntryId)
                        : undefined,
                    ),
                  )
                  .orderBy(...queueOrder)
                  .limit(1)
                  .pipe(Effect.orDie);
                if (!entry)
                  return {
                    promoted: false,
                    reason: input.jumpQueue ? "changed" : "empty",
                  } as const;
                if (entry.id !== input.expectedEntryId)
                  return { promoted: false, reason: "changed" } as const;

                const [userMessage] = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: conversation.id,
                    role: "user",
                    status: "complete",
                    content: entry.content,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                // The files change owner in the transaction that creates their
                // message, so no reader ever sees a turn without them.
                yield* attachments.transferQueueEntry(tx, {
                  queueEntryId: entry.id,
                  messageId: userMessage!.id,
                });
                yield* tx
                  .delete(conversationQueueEntries)
                  .where(eq(conversationQueueEntries.id, entry.id))
                  .pipe(Effect.orDie);
                const config = yield* resolveAttempt(
                  tx,
                  yield* readDefaults(tx, conversation.id),
                  input.resolve(entry),
                );
                const [assistant] = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: conversation.id,
                    role: "assistant",
                    status: "streaming",
                    generationLeaseUntil: freshLease(),
                    modelId: entry.input.modelId,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                yield* writeConfig(tx, assistant!.id, config);
                yield* tx
                  .update(conversations)
                  .set({
                    modelId: entry.input.modelId,
                    lastMessageAt: new Date(),
                    updatedAt: new Date(),
                    archivedAt: null,
                  })
                  .where(eq(conversations.id, conversation.id))
                  .pipe(Effect.orDie);
                return {
                  promoted: true,
                  entry,
                  conversation,
                  userMessage: userMessage!,
                  assistant: assistant!,
                  config,
                } as const;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        queueGate: (conversationId) => readQueueGate(db, conversationId),

        listQueue: Effect.fn("ChatRepo.listQueue")(function* (conversationId) {
          const rows = yield* db
            .select()
            .from(conversationQueueEntries)
            .where(eq(conversationQueueEntries.conversationId, conversationId))
            .orderBy(...queueOrder)
            .pipe(Effect.orDie);
          const files = yield* attachments.listForQueueEntries(rows.map((row) => row.id));
          return rows.map((row) => ({
            ...row,
            attachments: files
              .filter((file) => file.queueEntryId === row.id)
              .map(({ queueEntryId: _entry, position: _position, ...file }) => file),
          }));
        }),

        enqueue: Effect.fn("ChatRepo.enqueue")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockOwnedConversation(tx, input.userId, input.conversationId);
                const existing = yield* tx
                  .select({ id: conversationQueueEntries.id })
                  .from(conversationQueueEntries)
                  .where(eq(conversationQueueEntries.conversationId, input.conversationId))
                  .pipe(Effect.orDie);
                if (existing.length >= QUEUE_LIMIT)
                  return yield* new QueueFull({ conversationId: input.conversationId });
                const [entry] = yield* tx
                  .insert(conversationQueueEntries)
                  .values({
                    conversationId: input.conversationId,
                    userId: input.userId,
                    content: input.content,
                    input: input.input,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                // A fresh entry held nothing, so no files can be dropped here.
                yield* attachments.reconcileQueueEntry(tx, {
                  userId: input.userId,
                  queueEntryId: entry!.id,
                  attachmentIds: input.attachmentIds,
                });
                return entry!;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        replaceQueueEntry: Effect.fn("ChatRepo.replaceQueueEntry")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockOwnedConversation(tx, input.userId, input.conversationId);
                const [entry] = yield* tx
                  .update(conversationQueueEntries)
                  .set({
                    content: input.content,
                    input: input.input,
                    steerMessageId: null,
                    steerGenerationId: null,
                    lastError: null,
                  })
                  .where(
                    and(
                      eq(conversationQueueEntries.id, input.entryId),
                      eq(conversationQueueEntries.conversationId, input.conversationId),
                    ),
                  )
                  .returning({ id: conversationQueueEntries.id })
                  .pipe(Effect.orDie);
                // Promoted or removed meanwhile: the edit has nothing to land on.
                if (!entry) return yield* new QueueEntryNotFound({ entryId: input.entryId });
                return yield* attachments.reconcileQueueEntry(tx, {
                  userId: input.userId,
                  queueEntryId: entry.id,
                  attachmentIds: input.attachmentIds,
                });
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        removeQueueEntry: Effect.fn("ChatRepo.removeQueueEntry")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockOwnedConversation(tx, input.userId, input.conversationId);
                const [entry] = yield* tx
                  .select({ id: conversationQueueEntries.id })
                  .from(conversationQueueEntries)
                  .where(
                    and(
                      eq(conversationQueueEntries.id, input.entryId),
                      eq(conversationQueueEntries.conversationId, input.conversationId),
                    ),
                  )
                  .pipe(Effect.orDie);
                if (!entry) return [] as ReadonlyArray<string>;
                const keys = yield* attachments.releaseForQueueEntries(tx, [entry.id]);
                yield* tx
                  .delete(conversationQueueEntries)
                  .where(eq(conversationQueueEntries.id, entry.id))
                  .pipe(Effect.orDie);
                return keys;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        steerQueueEntry: Effect.fn("ChatRepo.steerQueueEntry")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* lockOwnedConversation(tx, input.userId, input.conversationId);
                const [entry] = yield* tx
                  .select({ id: conversationQueueEntries.id })
                  .from(conversationQueueEntries)
                  .where(
                    and(
                      eq(conversationQueueEntries.id, input.entryId),
                      eq(conversationQueueEntries.conversationId, input.conversationId),
                    ),
                  )
                  .pipe(Effect.orDie);
                if (!entry) return yield* new QueueEntryNotFound({ entryId: input.entryId });
                const [message] = yield* tx
                  .select({ id: messages.id })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.id, input.messageId),
                      eq(messages.conversationId, input.conversationId),
                      eq(messages.generationId, input.generationId),
                      eq(messages.status, "streaming"),
                    ),
                  )
                  .pipe(Effect.orDie);
                if (!message)
                  return yield* new NoActiveGeneration({ conversationId: input.conversationId });
                yield* tx
                  .update(conversationQueueEntries)
                  .set({ steerMessageId: input.messageId, steerGenerationId: input.generationId })
                  .where(eq(conversationQueueEntries.id, input.entryId))
                  .pipe(Effect.orDie);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        claimSteeredEntries: Effect.fn("ChatRepo.claimSteeredEntries")(function* (input) {
          const fence = yield* GenerationFence;
          if (!fence) return [] as Array<MessageRow & { queueEntryId: string }>;
          // Under the generation's own fence: a stopped or superseded attempt
          // is interrupted here, leaving every entry queued with its files.
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              const entries = yield* tx
                .select()
                .from(conversationQueueEntries)
                .where(
                  and(
                    eq(conversationQueueEntries.conversationId, input.conversationId),
                    eq(conversationQueueEntries.steerMessageId, input.messageId),
                    eq(conversationQueueEntries.steerGenerationId, fence.generationId),
                  ),
                )
                .orderBy(asc(conversationQueueEntries.id))
                .pipe(Effect.orDie);
              const steered: Array<MessageRow & { queueEntryId: string }> = [];
              if (entries.length === 0) return steered;
              // One at a time, in queue order: uuidv7 ids break the createdAt
              // tie between steers claimed together. They sort after their
              // answer, which began before them, and before anything later,
              // since nothing else can join the conversation while it runs.
              for (const entry of entries) {
                const [message] = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: input.conversationId,
                    role: "user",
                    status: "complete",
                    content: entry.content,
                    steeredIntoMessageId: input.messageId,
                    steerTextOffset: input.textOffset,
                    steerTurnIndex: input.turnIndex,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                yield* attachments.transferQueueEntry(tx, {
                  queueEntryId: entry.id,
                  messageId: message!.id,
                });
                steered.push({ ...message!, queueEntryId: entry.id });
              }
              yield* tx
                .delete(conversationQueueEntries)
                .where(
                  inArray(
                    conversationQueueEntries.id,
                    entries.map((entry) => entry.id),
                  ),
                )
                .pipe(Effect.orDie);
              return steered;
            }),
          );
        }),

        getConversationDefaults: (conversationId) => readDefaults(db, conversationId),

        getGenerationConfig: (messageId) => readConfig(db, messageId),
        listWorkspaceFilesByMessage: Effect.fn("ChatRepo.listWorkspaceFilesByMessage")(
          function* (messageIds) {
            if (messageIds.length === 0) return new Map<string, ReadonlyArray<string>>();
            const rows = yield* db
              .select({
                messageId: messageGenerationConfig.messageId,
                workspaceFiles: messageGenerationConfig.workspaceFiles,
              })
              .from(messageGenerationConfig)
              .where(inArray(messageGenerationConfig.messageId, [...messageIds]))
              .pipe(Effect.orDie);
            const byMessage = new Map<string, ReadonlyArray<string>>();
            for (const row of rows)
              if (row.workspaceFiles.length > 0) byMessage.set(row.messageId, row.workspaceFiles);
            return byMessage;
          },
        ),
        listGenerationDisplay: Effect.fn("ChatRepo.listGenerationDisplay")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          const rows = yield* db
            .select({
              messageId: messageGenerationConfig.messageId,
              collectionIds: messageGenerationConfig.collectionIds,
              skills: sql<
                Array<{ id: string; name: string }>
              >`coalesce((select jsonb_agg(jsonb_build_object('id', entry->>'skillId', 'name', entry->>'name')) from jsonb_array_elements(${messageGenerationConfig.skills}) entry where (entry->>'explicit')::boolean), '[]'::jsonb)`,
              desktopMachineId: messageGenerationConfig.desktopMachineId,
              desktopMachineName: messageGenerationConfig.desktopMachineName,
              workspaceFiles: messageGenerationConfig.workspaceFiles,
              desktopFolders: messageGenerationConfig.desktopFolders,
            })
            .from(messageGenerationConfig)
            .where(inArray(messageGenerationConfig.messageId, [...messageIds]))
            .pipe(Effect.orDie);
          if (rows.length !== new Set(messageIds).size)
            return yield* Effect.die(new Error("Missing generation configuration in conversation"));
          return rows
            .filter(
              (row) =>
                row.collectionIds.length > 0 ||
                row.skills.length > 0 ||
                row.desktopMachineId !== null ||
                row.workspaceFiles.length > 0 ||
                (row.desktopFolders?.length ?? 0) > 0,
            )
            .map(({ desktopMachineId, desktopMachineName, desktopFolders, ...row }) =>
              Object.assign(
                {},
                row,
                {
                  desktopMachine:
                    desktopMachineId === null
                      ? null
                      : { id: desktopMachineId, name: desktopMachineName },
                },
                // Browser-sent attempts (and work chats with no folder) store null.
                desktopFolders && desktopFolders.length > 0
                  ? { desktopRoots: [...desktopFolders] }
                  : {},
              ),
            );
        }),

        updateConversation: Effect.fn("ChatRepo.updateConversation")(
          function* (conversationId, patch) {
            yield* db
              .update(conversations)
              .set({ ...patch, updatedAt: new Date() })
              .where(eq(conversations.id, conversationId))
              .pipe(Effect.orDie);
          },
        ),

        keepConversation: Effect.fn("ChatRepo.keepConversation")(
          function* (userId, conversationId) {
            const rows = yield* db
              .update(conversations)
              .set({ temporary: false, updatedAt: new Date() })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  eq(conversations.userId, userId),
                  eq(conversations.temporary, true),
                ),
              )
              .returning({ id: conversations.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        setArchived: Effect.fn("ChatRepo.setArchived")(
          function* (userId, conversationId, archived) {
            const rows = yield* db
              .update(conversations)
              .set({ archivedAt: archived ? new Date() : null })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  eq(conversations.userId, userId),
                  eq(conversations.temporary, false),
                  archived ? isNull(conversations.archivedAt) : isNotNull(conversations.archivedAt),
                ),
              )
              .returning({ id: conversations.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        archiveAll: Effect.fn("ChatRepo.archiveAll")(function* (userId) {
          const rows = yield* db
            .update(conversations)
            .set({ archivedAt: new Date() })
            .where(listedBy(userId))
            .returning({ id: conversations.id })
            .pipe(Effect.orDie);
          return rows.map((row) => row.id);
        }),

        listArchived: Effect.fn("ChatRepo.listArchived")(function* (userId) {
          const rows = yield* db
            .select({
              id: conversations.id,
              title: conversations.title,
              archivedAt: conversations.archivedAt,
            })
            .from(conversations)
            .where(and(searchableBy(userId), isNotNull(conversations.archivedAt)))
            .orderBy(desc(conversations.archivedAt), desc(conversations.id))
            .pipe(Effect.orDie);
          return rows.flatMap(({ id, title, archivedAt }) =>
            archivedAt ? [{ id, title, archivedAt }] : [],
          );
        }),

        setTitleIfPending: Effect.fn("ChatRepo.setTitleIfPending")(
          function* (conversationId, title) {
            const rows = yield* db
              .update(conversations)
              .set({ title, updatedAt: new Date() })
              .where(and(eq(conversations.id, conversationId), isNull(conversations.title)))
              .returning({ id: conversations.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        deleteConversation: Effect.fn("ChatRepo.deleteConversation")(
          function* (userId, conversationId) {
            const deleted = yield* deleteLocked(conversationId, eq(conversations.userId, userId));
            return deleted?.keys ?? [];
          },
        ),

        listExpiredTemporary: Effect.fn("ChatRepo.listExpiredTemporary")(function* (limit) {
          return yield* db
            .select({ id: conversations.id })
            .from(conversations)
            .where(expiredTemporary)
            .orderBy(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`)
            .limit(limit)
            .pipe(Effect.orDie);
        }),

        deleteExpiredTemporary: (conversationId) => deleteLocked(conversationId, expiredTemporary),

        cloneConversationPrefix: Effect.fn("ChatRepo.cloneConversationPrefix")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* rejectReservedWorkTurn(tx, input.sourceConversationId);
                // Locks both sides of what is being copied: the conversation
                // row against a concurrent rename/title/delete, the messages
                // against a retry or edit rewinding history mid-copy.
                const sourceRows = yield* tx
                  .select()
                  .from(conversations)
                  .where(
                    and(
                      eq(conversations.id, input.sourceConversationId),
                      eq(conversations.userId, input.userId),
                    ),
                  )
                  .for("update")
                  .pipe(Effect.orDie);
                const source = sourceRows[0];
                if (!source) {
                  return yield* new ConversationNotFound({
                    conversationId: input.sourceConversationId,
                  });
                }

                const all = yield* tx
                  .select()
                  .from(messages)
                  .where(eq(messages.conversationId, source.id))
                  .orderBy(asc(messages.createdAt), asc(messages.id))
                  .for("update")
                  .pipe(Effect.orDie);

                // Position in the list, never the timestamp: two messages of
                // the same turn can share a clock tick.
                const index = all.findIndex((m) => m.id === input.throughMessageId);
                if (index === -1) {
                  return yield* new MessageNotFound({ messageId: input.throughMessageId });
                }
                const target = all[index]!;
                if (target.role !== "assistant") {
                  return yield* new BranchNotAllowed({
                    messageId: input.throughMessageId,
                    reason: "only assistant messages can be branched from",
                  });
                }
                // A steer sorts just after the answer it went into, so the
                // target's own steers follow it; they belong to that answer.
                let end = index + 1;
                while (all[end]?.steeredIntoMessageId === target.id) end += 1;
                const prefix = all.slice(0, end);
                // A cloned streaming row would have no fiber to finish it.
                if (prefix.some((m) => m.status === "streaming")) {
                  return yield* new BranchNotAllowed({
                    messageId: input.throughMessageId,
                    reason: "message is still generating",
                  });
                }

                // A branch stays in the project only while its owner may still use it.
                const branchProjectId =
                  source.projectId && (yield* projectRole(tx, source.userId, source.projectId))
                    ? source.projectId
                    : null;
                const branchRows = yield* tx
                  .insert(conversations)
                  .values({
                    id: uuidv7(),
                    userId: source.userId,
                    projectId: branchProjectId,
                    // Whatever the locked row says is used: a title that resolved
                    // between the service's read and this lock counts.
                    title: source.title,
                    modelId: source.modelId,
                    // A branch of a work chat is still work: its history is
                    // full of folder activity the continuation has to match.
                    // The approval level is a fact about the chat too.
                    mode: source.mode,
                    permissionLevel: source.permissionLevel,
                    // A copy of a temporary chat must not outlive it in the
                    // sidebar; it gets its own day from now.
                    temporary: source.temporary,
                    branchedFrom: source.id,
                    // Left null so the branch sorts by its own createdAt (now)
                    // and lands at the top of the list, like a new chat.
                    lastMessageAt: null,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                const branch = branchRows[0]!;
                // A chat's integration choices go with it, like its approval
                // level. Answers already given to waiting calls do not.
                const integrationChoices = yield* tx
                  .select()
                  .from(conversationIntegrations)
                  .where(eq(conversationIntegrations.conversationId, source.id))
                  .pipe(Effect.orDie);
                if (integrationChoices.length)
                  yield* tx
                    .insert(conversationIntegrations)
                    .values(
                      integrationChoices.map((choice) => ({
                        ...choice,
                        conversationId: branch.id,
                      })),
                    )
                    .pipe(Effect.orDie);

                const clonedIds = new Map(prefix.map((m) => [m.id, uuidv7()] as const));
                yield* tx
                  .insert(messages)
                  .values(
                    prefix.map((m) => ({
                      ...m,
                      id: clonedIds.get(m.id)!,
                      conversationId: branch.id,
                      generationId: null,
                      generationLeaseUntil: null,
                      // A steer sorts just before its answer, so the answer is
                      // always in the same prefix; point at the copy.
                      steeredIntoMessageId: m.steeredIntoMessageId
                        ? (clonedIds.get(m.steeredIntoMessageId) ?? null)
                        : null,
                      // createdAt/completedAt/editedAt stay as they were: the
                      // branch shows the same history, day dividers included.
                    })),
                  )
                  .pipe(Effect.orDie);

                const runIds = new Map<string, string>();
                const taskIds = new Map<string, string>();
                const clonedProgress = new Map<string, unknown>();
                for (const message of prefix) {
                  const run = (yield* tx
                    .select()
                    .from(researchRuns)
                    .where(eq(researchRuns.messageId, message.id))
                    .orderBy(asc(researchRuns.createdAt))
                    .pipe(Effect.orDie))[0];
                  if (!run || run.status !== "terminal") continue;
                  const id = uuidv7();
                  runIds.set(run.id, id);
                  const tasks = yield* tx
                    .select()
                    .from(researchTasks)
                    .where(eq(researchTasks.runId, run.id))
                    .pipe(Effect.orDie);
                  for (const task of tasks) taskIds.set(task.id, uuidv7());
                  const progress = projectResearchProgress({
                    ...run.progress,
                    runId: id,
                    tasks: run.progress.tasks.map((task) => ({
                      ...task,
                      id: taskIds.get(task.id)!,
                    })),
                  });
                  clonedProgress.set(run.id, progress);
                  yield* tx
                    .insert(researchRuns)
                    .values({
                      ...run,
                      id,
                      conversationId: branch.id,
                      messageId: clonedIds.get(message.id)!,
                      owner: null,
                      cancelRequested: false,
                      snapshot: true,
                      progress,
                    })
                    .pipe(Effect.orDie);
                  if (tasks.length)
                    yield* tx
                      .insert(researchTasks)
                      .values(
                        tasks.map((task) => ({ ...task, id: taskIds.get(task.id)!, runId: id })),
                      )
                      .pipe(Effect.orDie);
                }

                const attachmentIds = yield* attachments.cloneForMessages(tx, {
                  userId: input.userId,
                  messages: [...clonedIds].map(([sourceMessageId, targetMessageId]) => ({
                    sourceMessageId,
                    targetMessageId,
                  })),
                });

                // Tool calls are part of the answer, not of its generation:
                // the sources panel and the citation numbering both read them.
                const toolCalls = yield* tx
                  .select()
                  .from(messageToolCalls)
                  .where(inArray(messageToolCalls.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (toolCalls.length > 0) {
                  yield* tx
                    .insert(messageToolCalls)
                    .values(
                      toolCalls.map((call) => ({
                        ...call,
                        id: runIds.get(call.id) ?? uuidv7(),
                        researchRunId: call.researchRunId
                          ? (runIds.get(call.researchRunId) ?? null)
                          : null,
                        researchTaskId: call.researchTaskId
                          ? (taskIds.get(call.researchTaskId) ?? null)
                          : null,
                        result: clonedProgress.has(call.id)
                          ? ({
                              ...(call.result as object),
                              progress: clonedProgress.get(call.id),
                            } as JsonValue)
                          : withClonedFileIds(call.toolName, call.result, attachmentIds),
                        messageId: clonedIds.get(call.messageId)!,
                      })),
                    )
                    .pipe(Effect.orDie);
                }

                // A branch shows the same answers as the reader left them.
                const uiStates = yield* tx
                  .select()
                  .from(messageUiStates)
                  .where(inArray(messageUiStates.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (uiStates.length > 0) {
                  yield* tx
                    .insert(messageUiStates)
                    .values(
                      uiStates.map((row) => ({ ...row, messageId: clonedIds.get(row.messageId)! })),
                    )
                    .pipe(Effect.orDie);
                }

                // Agent/knowledge configuration is copied verbatim, never
                // re-resolved: the branch shows the same answers the same way,
                // and its next turn resolves the associated agent live.
                const [installedAgent] = yield* tx
                  .select()
                  .from(conversationAgents)
                  .where(eq(conversationAgents.conversationId, source.id))
                  .pipe(Effect.orDie);
                if (installedAgent)
                  yield* tx
                    .insert(conversationAgents)
                    .values({ ...installedAgent, conversationId: branch.id })
                    .pipe(Effect.orDie);
                const configs = yield* tx
                  .select()
                  .from(messageGenerationConfig)
                  .where(inArray(messageGenerationConfig.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (configs.length > 0)
                  yield* tx
                    .insert(messageGenerationConfig)
                    .values(
                      configs.map((row) => ({ ...row, messageId: clonedIds.get(row.messageId)! })),
                    )
                    .pipe(Effect.orDie);
                const skillRefs = yield* tx
                  .select()
                  .from(messageSkills)
                  .where(inArray(messageSkills.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (skillRefs.length)
                  yield* tx
                    .insert(messageSkills)
                    .values(
                      skillRefs.map((row) => ({
                        ...row,
                        messageId: clonedIds.get(row.messageId)!,
                      })),
                    )
                    .pipe(Effect.orDie);
                const manifests = yield* tx
                  .select()
                  .from(messageKnowledgeVersions)
                  .where(inArray(messageKnowledgeVersions.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (manifests.length > 0)
                  yield* tx
                    .insert(messageKnowledgeVersions)
                    .values(
                      manifests.map((row) => ({
                        ...row,
                        messageId: clonedIds.get(row.messageId)!,
                      })),
                    )
                    .pipe(Effect.orDie);

                const fileReferenceAliases = composeFileReferenceAliases({
                  sourceConversationId: source.id,
                  inherited: source.fileReferenceAliases,
                  attachmentIds,
                });
                yield* tx
                  .update(conversations)
                  .set({ fileReferenceAliases })
                  .where(eq(conversations.id, branch.id))
                  .pipe(Effect.orDie);
                for (const message of prefix) {
                  if (!message.assistantOutput) continue;
                  yield* tx
                    .update(messages)
                    .set({
                      assistantOutput: {
                        ...message.assistantOutput,
                        files: message.assistantOutput.files.map((file) => {
                          const id = attachmentIds.get(file.attachment.id);
                          if (!id) throw new Error("Missing cloned assistant file");
                          return { ...file, attachment: { ...file.attachment, id } };
                        }),
                        ...(message.assistantOutput.images
                          ? { images: remapUiImages(message.assistantOutput.images, attachmentIds) }
                          : {}),
                      },
                    })
                    .where(eq(messages.id, clonedIds.get(message.id)!))
                    .pipe(Effect.orDie);
                }

                // Compaction checkpoints follow the prefix they describe. Only
                // those whose boundary is inside the copied range are eligible,
                // since a summary ending past the branch point covers messages
                // this conversation does not have. createdAt is preserved so
                // the clones keep their relative age.
                const checkpoints = yield* tx
                  .select()
                  .from(conversationCompactionCheckpoints)
                  .where(eq(conversationCompactionCheckpoints.conversationId, source.id))
                  .pipe(Effect.orDie);
                const inherited = checkpoints.filter((checkpoint) =>
                  clonedIds.has(checkpoint.throughMessageId),
                );
                const checkpointIds = new Map(
                  inherited.map((checkpoint) => [checkpoint.id, uuidv7()] as const),
                );
                if (inherited.length > 0) {
                  yield* tx
                    .insert(conversationCompactionCheckpoints)
                    .values(
                      inherited.map((checkpoint) => ({
                        ...checkpoint,
                        id: checkpointIds.get(checkpoint.id)!,
                        conversationId: branch.id,
                        throughMessageId: clonedIds.get(checkpoint.throughMessageId)!,
                      })),
                    )
                    .pipe(Effect.orDie);
                }

                // Compaction activity belongs to the assistant row that
                // performed it. Clone every visible event in the copied prefix;
                // checkpoint linkage survives only when that semantic
                // checkpoint was itself valid for (and cloned into) the branch.
                const compactionEvents = yield* tx
                  .select()
                  .from(messageCompactionEvents)
                  .where(inArray(messageCompactionEvents.messageId, [...clonedIds.keys()]))
                  .pipe(Effect.orDie);
                if (compactionEvents.length > 0) {
                  yield* tx
                    .insert(messageCompactionEvents)
                    .values(
                      compactionEvents.map((event) => ({
                        ...event,
                        id: uuidv7(),
                        messageId: clonedIds.get(event.messageId)!,
                        researchRunId: event.researchRunId
                          ? (runIds.get(event.researchRunId) ?? null)
                          : null,
                        researchTaskId: event.researchTaskId
                          ? (taskIds.get(event.researchTaskId) ?? null)
                          : null,
                        checkpointId: event.checkpointId
                          ? (checkpointIds.get(event.checkpointId) ?? null)
                          : null,
                      })),
                    )
                    .pipe(Effect.orDie);
                }

                // message_chunks are deliberately not copied. They exist so a
                // reconnecting client can replay a live stream, and nothing in
                // the branch is live.
                return { ...branch, fileReferenceAliases };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        listMessages: Effect.fn("ChatRepo.listMessages")(function* (conversationId) {
          return yield* db
            .select()
            .from(messages)
            .where(eq(messages.conversationId, conversationId))
            // Total order: timestamps collide inside a turn, and every
            // position-based decision downstream (retry rewind, branch prefix,
            // compaction boundary) needs the sequence to be the same one twice.
            .orderBy(asc(messages.createdAt), asc(messages.id))
            .pipe(Effect.orDie);
        }),

        findWindowStart: Effect.fn("ChatRepo.findWindowStart")(
          function* (conversationId, turns, beforeId) {
            const [row] = yield* db
              .select({ id: messages.id })
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  // A turn opens on the person's own message. A steer belongs
                  // to the answer before it and a structured answer to the
                  // question before it, so neither may start a window.
                  eq(messages.role, "user"),
                  isNull(messages.steeredIntoMessageId),
                  isNull(messages.questionResponse),
                  beforeId ? positionBefore(beforeId) : undefined,
                ),
              )
              .orderBy(desc(messages.createdAt), desc(messages.id))
              .offset(turns - 1)
              .limit(1)
              .pipe(Effect.orDie);
            return row?.id ?? null;
          },
        ),

        listMessageWindow: Effect.fn("ChatRepo.listMessageWindow")(
          function* (conversationId, range) {
            return yield* db
              .select()
              .from(messages)
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  range.fromId ? not(positionBefore(range.fromId)) : undefined,
                  range.beforeId ? positionBefore(range.beforeId) : undefined,
                ),
              )
              // The same total order as listMessages.
              .orderBy(asc(messages.createdAt), asc(messages.id))
              .pipe(Effect.orDie);
          },
        ),

        hasMessagesBefore: Effect.fn("ChatRepo.hasMessagesBefore")(function* (conversationId, id) {
          const [row] = yield* db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), positionBefore(id)))
            .limit(1)
            .pipe(Effect.orDie);
          return row !== undefined;
        }),

        hasMessage: Effect.fn("ChatRepo.hasMessage")(function* (conversationId, id) {
          const [row] = yield* db
            .select({ id: messages.id })
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), eq(messages.id, id)))
            .pipe(Effect.orDie);
          return row !== undefined;
        }),

        latestMachineAttempt: Effect.fn("ChatRepo.latestMachineAttempt")(
          function* (conversationId) {
            const [row] = yield* db
              .select({
                messageId: messages.id,
                id: messageGenerationConfig.desktopMachineId,
                name: messageGenerationConfig.desktopMachineName,
              })
              .from(messageGenerationConfig)
              .innerJoin(messages, eq(messages.id, messageGenerationConfig.messageId))
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  sql`${messageGenerationConfig.desktopMachineId} is not null`,
                ),
              )
              .orderBy(desc(messages.createdAt), desc(messages.id))
              .limit(1)
              .pipe(Effect.orDie);
            return row?.id
              ? { messageId: row.messageId, desktopMachine: { id: row.id, name: row.name } }
              : null;
          },
        ),

        listSourcesBefore: Effect.fn("ChatRepo.listSourcesBefore")(
          function* (conversationId, id, indexes) {
            if (indexes.length === 0) return [];
            const wanted = new Set(indexes);
            const sources = sql`case when jsonb_typeof(${messageToolCalls.result}->'sources') = 'array' then ${messageToolCalls.result}->'sources' else '[]'::jsonb end`;
            const rows = yield* db
              .select({ result: messageToolCalls.result })
              .from(messageToolCalls)
              .innerJoin(messages, eq(messages.id, messageToolCalls.messageId))
              .where(
                and(
                  eq(messages.conversationId, conversationId),
                  positionBefore(id),
                  sql`exists (select 1 from jsonb_array_elements(${sources}) source where source->>'index' in (${sql.join(
                    [...wanted].map((index) => sql`${String(index)}`),
                    sql`, `,
                  )}))`,
                ),
              )
              .orderBy(
                asc(messages.createdAt),
                asc(messages.id),
                asc(messageToolCalls.turnIndex),
                asc(messageToolCalls.callIndex),
              )
              .pipe(Effect.orDie);
            return rows.flatMap((row) => {
              const found = (row.result as { sources?: unknown } | null)?.sources;
              return Array.isArray(found)
                ? found.filter((source: { index?: unknown }) => wanted.has(source?.index as number))
                : [];
            });
          },
        ),

        insertMessage: Effect.fn("ChatRepo.insertMessage")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [row] = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: input.conversationId,
                    role: input.role,
                    status: input.status ?? "complete",
                    generationLeaseUntil: input.status === "streaming" ? freshLease() : null,
                    content: input.content ?? "",
                    modelId: input.modelId,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                if (input.role === "assistant") yield* writeConfig(tx, row!.id, PLAIN_GENERATION);
                return row!;
              }),
            )
            .pipe(Effect.orDie);
        }),

        isDesktopAttemptLive: Effect.fn("ChatRepo.isDesktopAttemptLive")(function* (owner) {
          const rows = yield* db
            .select({ id: messages.id })
            .from(messages)
            .innerJoin(conversations, eq(messages.conversationId, conversations.id))
            .where(
              and(
                eq(conversations.userId, owner.userId),
                eq(conversations.id, owner.conversationId),
                eq(messages.id, owner.messageId),
                eq(messages.generationId, owner.generationId),
                eq(messages.status, "streaming"),
                sql`${messages.generationLeaseUntil} > clock_timestamp()`,
              ),
            )
            .pipe(Effect.orDie);
          return rows.length > 0;
        }),

        getMessage: Effect.fn("ChatRepo.getMessage")(function* (messageId) {
          const rows = yield* db
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
        }),

        appendChunks: Effect.fn("ChatRepo.appendChunks")(function* (messageId, chunks) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              // The periodic flusher calls this with an empty batch; renewing
              // before the early return is what keeps the lease alive between
              // chunks. The fence above makes a late renewal impossible.
              yield* tx
                .update(messages)
                .set({ generationLeaseUntil: sql`clock_timestamp() + ${GENERATION_LEASE}` })
                .where(eq(messages.id, messageId))
                .pipe(Effect.orDie);
              if (chunks.length === 0) return;
              yield* tx
                .insert(messageChunks)
                .values(
                  chunks.map((c) => ({ messageId, seq: c.seq, kind: c.kind, delta: c.delta })),
                )
                .pipe(Effect.orDie);
            }),
          );
        }),

        renewGenerationLease: Effect.fn("ChatRepo.renewGenerationLease")(
          function* (messageId, generationId) {
            yield* db
              .update(messages)
              .set({ generationLeaseUntil: sql`clock_timestamp() + ${GENERATION_LEASE}` })
              .where(
                and(
                  eq(messages.id, messageId),
                  eq(messages.generationId, generationId),
                  eq(messages.status, "streaming"),
                ),
              )
              .pipe(Effect.orDie, Effect.asVoid);
          },
        ),

        reapExpiredGenerations: Effect.fn("ChatRepo.reapExpiredGenerations")(function* () {
          const expired = yield* db
            .select({
              id: messages.id,
              conversationId: messages.conversationId,
              generationId: messages.generationId,
            })
            .from(messages)
            .where(
              and(
                eq(messages.status, "streaming"),
                // Judged by the database clock, like every other lease here. A
                // null lease is a row from before the column existed; every
                // path into "streaming" now grants one.
                sql`coalesce(${messages.generationLeaseUntil}, ${messages.createdAt} + ${GENERATION_LEASE}) <= clock_timestamp()`,
              ),
            )
            .pipe(Effect.orDie);
          const settled: Array<{
            userId: string;
            conversationId: string;
            messageId: string;
            generationId: string | null;
          }> = [];
          for (const row of expired) {
            const result = yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const [conversation] = yield* tx
                    .select({ userId: conversations.userId })
                    .from(conversations)
                    .where(eq(conversations.id, row.conversationId))
                    .for("update")
                    .pipe(Effect.orDie);
                  if (!conversation) return null;
                  const chunks = yield* tx
                    .select({ kind: messageChunks.kind, delta: messageChunks.delta })
                    .from(messageChunks)
                    .where(eq(messageChunks.messageId, row.id))
                    .orderBy(asc(messageChunks.seq))
                    .pipe(Effect.orDie);
                  const joined = (kind: "text" | "reasoning") => joinChunks(chunks, kind);
                  // Same identity check as the fence: a retry that already
                  // reclaimed the row must not be overwritten by stale cleanup.
                  const claimed = yield* tx
                    .update(messages)
                    .set({
                      status: "error",
                      content: joined("text"),
                      reasoning: joined("reasoning"),
                      error: { tag: "GenerationFailed", message: INTERRUPTED_MESSAGE },
                      completedAt: new Date(),
                    })
                    .where(
                      and(
                        eq(messages.id, row.id),
                        eq(messages.status, "streaming"),
                        row.generationId === null
                          ? isNull(messages.generationId)
                          : eq(messages.generationId, row.generationId),
                        sql`coalesce(${messages.generationLeaseUntil}, ${messages.createdAt} + ${GENERATION_LEASE}) <= clock_timestamp()`,
                      ),
                    )
                    .returning({ id: messages.id })
                    .pipe(Effect.orDie);
                  if (claimed.length === 0) return null;
                  const interrupted = {
                    status: "error" as const,
                    error: { code: "GenerationFailed", message: INTERRUPTED_MESSAGE },
                    completedAt: new Date(),
                  };
                  yield* tx
                    .update(messageToolCalls)
                    .set(interrupted)
                    .where(
                      and(
                        eq(messageToolCalls.messageId, row.id),
                        eq(messageToolCalls.status, "running"),
                      ),
                    )
                    .pipe(Effect.orDie);
                  yield* tx
                    .update(messageCompactionEvents)
                    .set(interrupted)
                    .where(
                      and(
                        eq(messageCompactionEvents.messageId, row.id),
                        eq(messageCompactionEvents.status, "running"),
                      ),
                    )
                    .pipe(Effect.orDie);
                  return {
                    userId: conversation.userId,
                    conversationId: row.conversationId,
                    messageId: row.id,
                    generationId: row.generationId,
                  };
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
            if (result) settled.push(result);
          }
          return settled;
        }),

        lastChunkSeq: Effect.fn("ChatRepo.lastChunkSeq")(function* (messageId) {
          const [row] = yield* db
            .select({ seq: max(messageChunks.seq) })
            .from(messageChunks)
            .where(eq(messageChunks.messageId, messageId))
            .pipe(Effect.orDie);
          return row?.seq ?? 0;
        }),
        chunksAfter: Effect.fn("ChatRepo.chunksAfter")(function* (messageId, afterSeq) {
          return yield* db
            .select({
              seq: messageChunks.seq,
              kind: messageChunks.kind,
              delta: messageChunks.delta,
              createdAt: messageChunks.createdAt,
            })
            .from(messageChunks)
            .where(and(eq(messageChunks.messageId, messageId), gt(messageChunks.seq, afterSeq)))
            .orderBy(asc(messageChunks.seq))
            .pipe(Effect.orDie);
        }),

        insertToolCall: Effect.fn("ChatRepo.insertToolCall")(function* (input) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(messageToolCalls)
                .values({ ...input, status: "running" })
                .pipe(Effect.orDie);
            }),
          );
        }),

        settleToolCall: Effect.fn("ChatRepo.settleToolCall")(function* (input) {
          return yield* generationWrite((tx) =>
            tx
              .update(messageToolCalls)
              .set({ status: input.status, error: input.error, completedAt: new Date() })
              .where(eq(messageToolCalls.id, input.id))
              .pipe(Effect.orDie, Effect.asVoid),
          );
        }),
        completeToolCall: Effect.fn("ChatRepo.completeToolCall")(function* (input) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(messageToolCalls)
                .set({
                  result: input.result,
                  status: input.status,
                  error: input.error,
                  completedAt: new Date(),
                })
                .where(eq(messageToolCalls.id, input.id))
                .pipe(Effect.orDie);
            }),
          );
        }),

        keepFailedCallArguments: Effect.fn("ChatRepo.keepFailedCallArguments")(function* (calls) {
          if (!calls.length) return;
          const failed = yield* db
            .select({ id: messageToolCalls.id })
            .from(messageToolCalls)
            .where(
              and(
                inArray(
                  messageToolCalls.id,
                  calls.map((call) => call.id),
                ),
                eq(messageToolCalls.status, "error"),
              ),
            )
            .pipe(Effect.orDie);
          const ids = new Set(failed.map((row) => row.id));
          const rows = calls
            .filter((call) => ids.has(call.id))
            .map((call) => ({ toolCallId: call.id, arguments: call.arguments }));
          if (rows.length)
            yield* db
              .insert(toolCallDebugArguments)
              .values(rows)
              .onConflictDoNothing()
              .pipe(Effect.orDie);
        }),
        sweepFailedCallArguments: Effect.fn("ChatRepo.sweepFailedCallArguments")(function* () {
          const removed = yield* db
            .delete(toolCallDebugArguments)
            .where(sql`${toolCallDebugArguments.createdAt} < now() - interval '7 days'`)
            .returning({ id: toolCallDebugArguments.toolCallId })
            .pipe(Effect.orDie);
          return removed.length;
        }),
        failRunningToolCalls: Effect.fn("ChatRepo.failRunningToolCalls")(
          function* (messageId, message) {
            return yield* generationWrite((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(messageToolCalls)
                  .set({
                    status: "error",
                    error: { code: "GenerationFailed", message },
                    completedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(messageToolCalls.messageId, messageId),
                      eq(messageToolCalls.status, "running"),
                    ),
                  )
                  .pipe(Effect.orDie);
              }),
            );
          },
        ),

        listUiStates: Effect.fn("ChatRepo.listUiStates")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          return yield* db
            .select()
            .from(messageUiStates)
            .where(inArray(messageUiStates.messageId, [...messageIds]))
            .orderBy(asc(messageUiStates.messageId), asc(messageUiStates.ordinal))
            .pipe(Effect.orDie);
        }),

        recordUiImages: Effect.fn("ChatRepo.recordUiImages")(function* (fence, query, result) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const message = yield* lockGeneration(tx, fence);
                const output = message.assistantOutput;
                const images = { ...output?.images, [query]: result };
                yield* tx
                  .update(messages)
                  .set({ assistantOutput: { ...output, v: 1, files: output?.files ?? [], images } })
                  .where(eq(messages.id, fence.messageId))
                  .pipe(Effect.orDie);
                return images;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        saveUiState: Effect.fn("ChatRepo.saveUiState")(function* (input) {
          if (
            !Number.isSafeInteger(input.ordinal) ||
            input.ordinal < 0 ||
            input.ordinal >= MAX_UI_BLOCKS
          ) {
            return "refused" as const;
          }
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const [target] = yield* tx
                  .select({ conversationId: messages.conversationId })
                  .from(messages)
                  .where(eq(messages.id, input.messageId))
                  .pipe(Effect.orDie);
                if (!target) return "refused" as const;
                // The conversation lock is the one retry and edit take, so a
                // reset cannot slip between this check and the write.
                const owned = yield* tx
                  .select({ id: conversations.id })
                  .from(conversations)
                  .where(
                    and(
                      eq(conversations.id, target.conversationId),
                      eq(conversations.userId, input.userId),
                    ),
                  )
                  .for("update")
                  .pipe(Effect.orDie);
                if (owned.length === 0) return "refused" as const;
                const [message] = yield* tx
                  .select({
                    role: messages.role,
                    status: messages.status,
                    generationId: messages.generationId,
                    content: messages.content,
                  })
                  .from(messages)
                  .where(eq(messages.id, input.messageId))
                  .pipe(Effect.orDie);
                const fence = message ? scanUiFences(message.content)[input.ordinal] : undefined;
                if (
                  !message ||
                  message.role !== "assistant" ||
                  message.status === "streaming" ||
                  message.generationId !== input.generationId ||
                  !fence?.closed ||
                  hashSource(fence.code) !== input.sourceHash
                ) {
                  return "refused" as const;
                }
                yield* tx
                  .insert(messageUiStates)
                  .values({
                    messageId: input.messageId,
                    ordinal: input.ordinal,
                    sourceHash: input.sourceHash,
                    state: input.state,
                  })
                  .onConflictDoUpdate({
                    target: [messageUiStates.messageId, messageUiStates.ordinal],
                    set: {
                      sourceHash: input.sourceHash,
                      state: input.state,
                      updatedAt: new Date(),
                    },
                  })
                  .pipe(Effect.orDie);
                return "saved" as const;
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        listToolCalls: Effect.fn("ChatRepo.listToolCalls")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          return yield* db
            .select()
            .from(messageToolCalls)
            .where(inArray(messageToolCalls.messageId, [...messageIds]))
            .orderBy(
              asc(messageToolCalls.messageId),
              asc(messageToolCalls.turnIndex),
              asc(messageToolCalls.callIndex),
            )
            .pipe(Effect.orDie);
        }),

        createCompactionEvent: Effect.fn("ChatRepo.createCompactionEvent")(function* (input) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(messageCompactionEvents)
                .values({ ...input, status: "running" })
                .pipe(Effect.orDie);
            }),
          );
        }),

        completeCompactionEvent: Effect.fn("ChatRepo.completeCompactionEvent")(function* (input) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(messageCompactionEvents)
                .set({
                  status: input.status,
                  outcome: input.outcome,
                  checkpointId: input.checkpointId,
                  summary: input.summary,
                  error: input.error,
                  completedAt: new Date(),
                })
                .where(eq(messageCompactionEvents.id, input.id))
                .pipe(Effect.orDie);
            }),
          );
        }),

        failRunningCompactionEvents: Effect.fn("ChatRepo.failRunningCompactionEvents")(
          function* (messageId, message) {
            return yield* generationWrite((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .update(messageCompactionEvents)
                  .set({
                    status: "error",
                    error: { code: "GenerationFailed", message },
                    completedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(messageCompactionEvents.messageId, messageId),
                      eq(messageCompactionEvents.status, "running"),
                    ),
                  )
                  .pipe(Effect.orDie);
              }),
            );
          },
        ),

        listCompactionEvents: Effect.fn("ChatRepo.listCompactionEvents")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          return yield* db
            .select()
            .from(messageCompactionEvents)
            .where(inArray(messageCompactionEvents.messageId, [...messageIds]))
            .orderBy(
              asc(messageCompactionEvents.messageId),
              asc(messageCompactionEvents.beforeTurnIndex),
              asc(messageCompactionEvents.passIndex),
            )
            .pipe(Effect.orDie);
        }),

        failGeneration: Effect.fn("ChatRepo.failGeneration")(function* (input) {
          yield* generationWrite((tx) =>
            Effect.gen(function* () {
              const chunks = yield* tx
                .select({ kind: messageChunks.kind, delta: messageChunks.delta })
                .from(messageChunks)
                .where(eq(messageChunks.messageId, input.messageId))
                .orderBy(asc(messageChunks.seq));
              const joined = (kind: "text" | "reasoning") => joinChunks(chunks, kind);
              const failed = {
                status: "error" as const,
                error: { code: "GenerationFailed", message: input.error },
                completedAt: new Date(),
              };
              yield* tx
                .update(messageToolCalls)
                .set(failed)
                .where(
                  and(
                    eq(messageToolCalls.messageId, input.messageId),
                    eq(messageToolCalls.status, "running"),
                  ),
                );
              yield* tx
                .update(messageCompactionEvents)
                .set(failed)
                .where(
                  and(
                    eq(messageCompactionEvents.messageId, input.messageId),
                    eq(messageCompactionEvents.status, "running"),
                  ),
                );
              yield* tx
                .update(messages)
                .set({
                  status: "error",
                  content: joined("text"),
                  reasoning: joined("reasoning"),
                  error: { tag: "GenerationFailed", message: input.error },
                  completedAt: new Date(),
                })
                .where(eq(messages.id, input.messageId));
              yield* tx.insert(usageEvents).values({ id: uuidv7(), ...input.ledger });
              yield* tx
                .update(conversations)
                .set({ lastMessageAt: new Date() })
                .where(eq(conversations.id, input.ledger.conversationId));
            }),
          ).pipe(Effect.orDie);
        }),

        finalizeMessage: Effect.fn("ChatRepo.finalizeMessage")(function* (input) {
          return yield* generationWrite((tx) =>
            Effect.gen(function* () {
              yield* tx
                .update(messages)
                .set({
                  status: input.status,
                  content: input.content,
                  reasoning: input.reasoning ?? "",
                  usage: input.usage,
                  error: input.error,
                  completedAt: new Date(),
                })
                .where(eq(messages.id, input.messageId))
                .pipe(Effect.orDie);
              if (input.ledger) {
                // Terminal state and accounting must either both commit or both roll back.
                yield* tx
                  .insert(usageEvents)
                  .values({ id: uuidv7(), ...input.ledger })
                  .pipe(Effect.orDie);
                yield* tx
                  .update(conversations)
                  .set({ lastMessageAt: new Date() })
                  .where(eq(conversations.id, input.ledger.conversationId))
                  .pipe(Effect.orDie);
              }
            }),
          );
        }),

        resetMessageForRetry: Effect.fn("ChatRepo.resetMessageForRetry")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const lost = { claimed: false, orphanedKeys: [] as ReadonlyArray<string> };
                // Resolve the parent without locking a message first. Every path
                // that changes eligibility takes the conversation lock before rows.
                const target = (yield* tx
                  .select({ conversationId: messages.conversationId })
                  .from(messages)
                  .where(eq(messages.id, input.messageId))
                  .pipe(Effect.orDie))[0];
                if (!target) return lost;
                yield* rejectReservedWorkTurn(tx, target.conversationId);
                const owned = yield* tx
                  .select({ id: conversations.id })
                  .from(conversations)
                  .where(
                    and(
                      eq(conversations.id, target.conversationId),
                      eq(conversations.userId, input.userId),
                    ),
                  )
                  .for("update")
                  .pipe(Effect.orDie);
                if (owned.length === 0) return lost;
                const current = yield* tx
                  .select()
                  .from(messages)
                  .where(eq(messages.conversationId, target.conversationId))
                  .orderBy(asc(messages.createdAt), asc(messages.id))
                  .pipe(Effect.orDie);
                if (
                  current.some((message) => message.status === "streaming") ||
                  !matchesHistory(current, input.expectedMessages)
                )
                  return lost;
                const index = current.findIndex(
                  (message) => message.id === input.messageId && message.role === "assistant",
                );
                if (
                  index < 0 ||
                  JSON.stringify(current.slice(index + 1).map((message) => message.id)) !==
                    JSON.stringify(input.deleteMessageIds)
                )
                  return lost;
                if (
                  input.edit &&
                  !current
                    .slice(0, index)
                    .some(
                      (message) => message.id === input.edit?.messageId && message.role === "user",
                    )
                )
                  return lost;
                const edited = input.edit
                  ? yield* editedContent(tx, current, input.edit.messageId, input.edit)
                  : null;
                const previous = yield* readConfig(tx, input.messageId);
                const config = yield* resolveAttempt(
                  tx,
                  yield* readDefaults(tx, target.conversationId),
                  input.resolve,
                  previous,
                );
                const generationId = uuidv7();
                const claimed = yield* tx
                  .update(messages)
                  .set({
                    status: "streaming",
                    generationId,
                    generationLeaseUntil: freshLease(),
                    assistantOutput: null,
                    providerReplay: null,
                    content: "",
                    reasoning: "",
                    usage: null,
                    error: null,
                    completedAt: null,
                    modelId: input.modelId,
                  })
                  .where(and(eq(messages.id, input.messageId), ne(messages.status, "streaming")))
                  .returning({ id: messages.id })
                  .pipe(Effect.orDie);
                if (claimed.length === 0) {
                  return { claimed: false, orphanedKeys: [] as ReadonlyArray<string> };
                }

                const orphanedKeys: string[] = [
                  ...(yield* attachments.releaseForMessages(tx, [input.messageId])),
                ];
                // A new attempt writes a new answer; its blocks start from their own state.
                yield* tx
                  .delete(messageUiStates)
                  .where(eq(messageUiStates.messageId, input.messageId))
                  .pipe(Effect.orDie);

                if (input.edit) {
                  yield* tx
                    .update(messages)
                    .set({ ...edited!, editedAt: new Date() })
                    .where(eq(messages.id, input.edit.messageId))
                    .pipe(Effect.orDie);
                  orphanedKeys.push(
                    ...(yield* attachments.reconcile(tx, {
                      userId: input.userId,
                      messageId: input.edit.messageId,
                      attachmentIds: input.edit.attachmentIds,
                    })),
                  );
                  yield* tx
                    .update(conversations)
                    .set({ modelId: input.modelId, updatedAt: new Date() })
                    .where(eq(conversations.id, input.edit.conversationId))
                    .pipe(Effect.orDie);
                }
                // A retry or an edit is writing in the chat, so it unarchives it.
                yield* tx
                  .update(conversations)
                  .set({ archivedAt: null })
                  .where(
                    and(
                      eq(conversations.id, target.conversationId),
                      isNotNull(conversations.archivedAt),
                    ),
                  )
                  .pipe(Effect.orDie);

                if (input.invalidateCheckpointThroughMessageIds.length > 0) {
                  yield* tx
                    .delete(conversationCompactionCheckpoints)
                    .where(
                      inArray(conversationCompactionCheckpoints.throughMessageId, [
                        ...input.invalidateCheckpointThroughMessageIds,
                      ]),
                    )
                    .pipe(Effect.orDie);
                }
                if (input.deleteMessageIds.length > 0) {
                  orphanedKeys.push(
                    ...(yield* attachments.releaseForMessages(tx, input.deleteMessageIds)),
                  );
                  yield* tx
                    .delete(messages)
                    .where(inArray(messages.id, [...input.deleteMessageIds]))
                    .pipe(Effect.orDie);
                }
                yield* tx
                  .delete(messageChunks)
                  .where(eq(messageChunks.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageToolCalls)
                  .where(eq(messageToolCalls.messageId, input.messageId))
                  .pipe(Effect.orDie);
                // This answer is being generated again, so what it produced goes
                // with it. Messages that are deleted outright take their
                // documents and drafts through the foreign key instead; retry
                // keeps the row id, so those have to be removed explicitly.
                yield* tx
                  .delete(documents)
                  .where(eq(documents.createdByMessageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(conversationDrafts)
                  .where(eq(conversationDrafts.createdByMessageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageCompactionEvents)
                  .where(eq(messageCompactionEvents.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageKnowledgeVersions)
                  .where(eq(messageKnowledgeVersions.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageGenerationConfig)
                  .where(eq(messageGenerationConfig.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* writeConfig(tx, input.messageId, config);

                return {
                  claimed: true,
                  generationId,
                  searchEnabled: config.searchEnabled,
                  orphanedKeys: orphanedKeys as ReadonlyArray<string>,
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        resumeMessage: Effect.fn("ChatRepo.resumeMessage")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const lost = { claimed: false as const };
                const target = (yield* tx
                  .select({ conversationId: messages.conversationId })
                  .from(messages)
                  .where(eq(messages.id, input.messageId))
                  .pipe(Effect.orDie))[0];
                if (!target) return lost;
                yield* rejectReservedWorkTurn(tx, target.conversationId);
                const owned = yield* tx
                  .select({ id: conversations.id })
                  .from(conversations)
                  .where(
                    and(
                      eq(conversations.id, target.conversationId),
                      eq(conversations.userId, input.userId),
                    ),
                  )
                  .for("update")
                  .pipe(Effect.orDie);
                if (owned.length === 0) return lost;
                const streaming = yield* tx
                  .select({ id: messages.id })
                  .from(messages)
                  .where(
                    and(
                      eq(messages.conversationId, target.conversationId),
                      eq(messages.status, "streaming"),
                    ),
                  )
                  .pipe(Effect.orDie);
                if (streaming.length > 0) return lost;
                // Only the last turn can continue: a later turn would have been
                // answered without whatever the resumed answer goes on to say.
                const [tail] = yield* tx
                  .select()
                  .from(messages)
                  .where(turnMessagesOf(target.conversationId))
                  .orderBy(desc(messages.createdAt), desc(messages.id))
                  .limit(1)
                  .pipe(Effect.orDie);
                if (
                  tail?.id !== input.messageId ||
                  tail.role !== "assistant" ||
                  (tail.status !== "error" && tail.status !== "aborted")
                )
                  return lost;
                const config = yield* resolveAttempt(
                  tx,
                  yield* readDefaults(tx, target.conversationId),
                  input.resolve,
                  yield* readConfig(tx, input.messageId),
                );
                const chunks = yield* tx
                  .select({ kind: messageChunks.kind, delta: messageChunks.delta })
                  .from(messageChunks)
                  .where(eq(messageChunks.messageId, input.messageId))
                  .orderBy(asc(messageChunks.seq))
                  .pipe(Effect.orDie);
                // A branch copies an answer's text but never its chunks. The
                // client rebuilds a streaming answer from chunks alone, so the
                // copied text becomes the first ones; otherwise the chunks are
                // the text, as the reaper reads them.
                if (chunks.length === 0) {
                  const seeded = [
                    ...(tail.reasoning
                      ? [{ kind: "reasoning" as const, delta: tail.reasoning }]
                      : []),
                    ...(tail.content ? [{ kind: "text" as const, delta: tail.content }] : []),
                  ];
                  if (seeded.length > 0)
                    yield* tx
                      .insert(messageChunks)
                      .values(
                        seeded.map((chunk, index) => ({
                          messageId: input.messageId,
                          seq: index + 1,
                          ...chunk,
                        })),
                      )
                      .pipe(Effect.orDie);
                }
                const joined = (kind: "text" | "reasoning") => joinChunks(chunks, kind);
                const generationId = uuidv7();
                const claimed = yield* tx
                  .update(messages)
                  .set({
                    status: "streaming",
                    generationId,
                    generationLeaseUntil: freshLease(),
                    error: null,
                    completedAt: null,
                    modelId: input.modelId,
                    ...(chunks.length > 0
                      ? { content: joined("text"), reasoning: joined("reasoning") }
                      : {}),
                    // Signed image turns belong to the model that wrote them;
                    // another model's turns are never merged into them.
                    ...(input.modelId === tail.modelId ? {} : { providerReplay: null }),
                  })
                  .where(
                    and(
                      eq(messages.id, input.messageId),
                      inArray(messages.status, ["error", "aborted"]),
                    ),
                  )
                  .returning({ id: messages.id })
                  .pipe(Effect.orDie);
                if (claimed.length === 0) return lost;
                // A steer sent to the ended attempt was meant for this answer,
                // so the attempt that continues it takes it in.
                yield* tx
                  .update(conversationQueueEntries)
                  .set({ steerGenerationId: generationId })
                  .where(
                    and(
                      eq(conversationQueueEntries.conversationId, target.conversationId),
                      eq(conversationQueueEntries.steerMessageId, input.messageId),
                    ),
                  )
                  .pipe(Effect.orDie);
                yield* tx
                  .update(conversations)
                  .set({ archivedAt: null })
                  .where(
                    and(
                      eq(conversations.id, target.conversationId),
                      isNotNull(conversations.archivedAt),
                    ),
                  )
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageKnowledgeVersions)
                  .where(eq(messageKnowledgeVersions.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* tx
                  .delete(messageGenerationConfig)
                  .where(eq(messageGenerationConfig.messageId, input.messageId))
                  .pipe(Effect.orDie);
                yield* writeConfig(tx, input.messageId, config);
                return {
                  claimed: true as const,
                  generationId,
                  searchEnabled: config.searchEnabled,
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        createAssistantForEdit: Effect.fn("ChatRepo.createAssistantForEdit")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* rejectReservedWorkTurn(tx, input.conversationId);
                const owned = yield* tx
                  .select({ id: conversations.id })
                  .from(conversations)
                  .where(
                    and(
                      eq(conversations.id, input.conversationId),
                      eq(conversations.userId, input.userId),
                    ),
                  )
                  .for("update")
                  .pipe(Effect.orDie);
                if (owned.length === 0) return null;
                const current = yield* tx
                  .select()
                  .from(messages)
                  .where(eq(messages.conversationId, input.conversationId))
                  .orderBy(asc(messages.createdAt), asc(messages.id))
                  .pipe(Effect.orDie);
                if (
                  current.some((message) => message.status === "streaming") ||
                  !matchesHistory(current, input.expectedMessages)
                )
                  return null;
                const index = current.findIndex((message) => message.id === input.userMessageId);
                if (
                  index < 0 ||
                  JSON.stringify(current.slice(index + 1).map((message) => message.id)) !==
                    JSON.stringify(input.deleteMessageIds)
                )
                  return null;
                const edited = yield* editedContent(tx, current, input.userMessageId, input);
                const config = yield* resolveAttempt(
                  tx,
                  yield* readDefaults(tx, input.conversationId),
                  input.resolve,
                );
                const claimed = yield* tx
                  .update(messages)
                  .set({ ...edited, editedAt: new Date() })
                  .where(
                    and(
                      eq(messages.id, input.userMessageId),
                      eq(messages.conversationId, input.conversationId),
                      eq(messages.role, "user"),
                      eq(messages.status, "complete"),
                      input.expectedEditedAt === null
                        ? isNull(messages.editedAt)
                        : eq(messages.editedAt, input.expectedEditedAt),
                    ),
                  )
                  .returning({ id: messages.id })
                  .pipe(Effect.orDie);
                if (claimed.length === 0) return null;

                const orphanedKeys: string[] = [
                  ...(yield* attachments.reconcile(tx, {
                    userId: input.userId,
                    messageId: input.userMessageId,
                    attachmentIds: input.attachmentIds,
                  })),
                ];

                if (input.invalidateCheckpointThroughMessageIds.length > 0) {
                  yield* tx
                    .delete(conversationCompactionCheckpoints)
                    .where(
                      inArray(conversationCompactionCheckpoints.throughMessageId, [
                        ...input.invalidateCheckpointThroughMessageIds,
                      ]),
                    )
                    .pipe(Effect.orDie);
                }
                if (input.deleteMessageIds.length > 0) {
                  orphanedKeys.push(
                    ...(yield* attachments.releaseForMessages(tx, input.deleteMessageIds)),
                  );
                  yield* tx
                    .delete(messages)
                    .where(inArray(messages.id, [...input.deleteMessageIds]))
                    .pipe(Effect.orDie);
                }
                yield* tx
                  .update(conversations)
                  .set({ modelId: input.modelId, updatedAt: new Date(), archivedAt: null })
                  .where(eq(conversations.id, input.conversationId))
                  .pipe(Effect.orDie);

                const created = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: input.conversationId,
                    role: "assistant",
                    status: "streaming",
                    generationLeaseUntil: freshLease(),
                    modelId: input.modelId,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                yield* writeConfig(tx, created[0]!.id, config);
                return {
                  message: created[0]!,
                  orphanedKeys: orphanedKeys as ReadonlyArray<string>,
                  config,
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        deleteMessages: Effect.fn("ChatRepo.deleteMessages")(function* (messageIds) {
          if (messageIds.length === 0) return [] as ReadonlyArray<string>;
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // Serialize deletion with late generated-image registration before releasing refs.
                const owners = yield* tx
                  .selectDistinct({ id: messages.conversationId })
                  .from(messages)
                  .where(inArray(messages.id, [...messageIds]));
                const ids = owners.map((row) => row.id);
                if (ids.length)
                  yield* tx
                    .select({ id: conversations.id })
                    .from(conversations)
                    .where(inArray(conversations.id, ids))
                    .orderBy(asc(conversations.id))
                    .for("update");
                const keys = yield* attachments.releaseForMessages(tx, messageIds);
                yield* tx.delete(messages).where(inArray(messages.id, [...messageIds]));
                return keys;
              }),
            )
            .pipe(Effect.orDie);
        }),

        listCompactionCheckpoints: Effect.fn("ChatRepo.listCompactionCheckpoints")(
          function* (conversationId) {
            return yield* db
              .select()
              .from(conversationCompactionCheckpoints)
              .where(eq(conversationCompactionCheckpoints.conversationId, conversationId))
              .orderBy(asc(conversationCompactionCheckpoints.createdAt))
              .pipe(Effect.orDie);
          },
        ),

        insertCompactionCheckpoint: Effect.fn("ChatRepo.insertCompactionCheckpoint")(
          function* (input) {
            return yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  const fence = yield* GenerationFence;
                  if (fence) yield* lockGeneration(tx, fence);
                  // Serializes against a branch clone reading the checkpoint set,
                  // and against a second generation summarizing the same range.
                  const locked = yield* tx
                    .select({ id: conversations.id })
                    .from(conversations)
                    .where(eq(conversations.id, input.conversationId))
                    .for("update")
                    .pipe(Effect.orDie);
                  if (locked.length === 0) return null;

                  const rows = yield* tx
                    .insert(conversationCompactionCheckpoints)
                    .values({ id: uuidv7(), ...input })
                    // A concurrent generation that summarized the same boundary
                    // first wins; both summaries describe the same messages.
                    .onConflictDoNothing()
                    .returning()
                    .pipe(Effect.orDie);
                  return rows[0] ?? null;
                }),
              )
              .pipe(Effect.catchTag("SqlError", Effect.die));
          },
        ),
      });
    }),
  );
}
