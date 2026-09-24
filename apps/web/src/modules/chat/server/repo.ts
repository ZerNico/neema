import type { UsageEventInput } from "~/modules/analytics/server/repo.ts";
import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { GenerationFence, lockGeneration } from "./generation-fence.ts";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
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
  conversationDocuments,
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
  schedules,
  scheduleRuns,
  usageEvents,
  workTurnReservations,
  conversationIntegrations,
} from "~/db/schema/index.ts";
import type { ResolvedAgentConfig } from "~/db/schema/agents.ts";
import type { AgentNotAvailable } from "~/modules/agents/errors.ts";
import type { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import type { ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { AttachmentNotAvailable } from "~/modules/attachments/errors.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
import { AttachmentRepo, type DbTx } from "~/modules/attachments/server/repo.ts";
import { escapeLike } from "~/server/sql.ts";
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
  /** The machine the attempt was sent from; null predates machine stamping. */
  readonly desktopMachineId?: string | null;
  readonly desktopMachineName?: string | null;
  /** Workspace files this turn's send claimed; empty for every other attempt. */
  readonly workspaceFiles?: ReadonlyArray<string>;
  /** A schedule fire's up-front integration consent; null with a person present. */
  readonly integrationGrants?: ReadonlyArray<{
    readonly integrationId: string;
    readonly access: "read" | "write";
  }> | null;
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

/** The fixed association, not an agent configuration snapshot. */
export interface ConversationDefaults {
  readonly agent: { agentId: string | null } | null;
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
  | { readonly kind: "new"; readonly id: string; readonly mode: "chat" | "work" }
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
   * marks the chat as a scheduled run so the sidebar list omits it.
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

export type ChunkKind = "text" | "reasoning" | "tool" | "compaction" | "file" | "steer";
export type ChunkRow = { seq: number; kind: ChunkKind; delta: string };
/**
 * Durable tool-call projection safe for clients (summaries only, no page bodies).
 */
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
  const documents = yield* tx
    .select({
      id: conversationDocuments.id,
      title: conversationDocuments.title,
      // The answer it belongs to, so the transcript can place a card whose
      // creating tool row a rewind took with it. Never any content.
      messageId: conversationDocuments.createdByMessageId,
    })
    .from(conversationDocuments)
    .where(eq(conversationDocuments.conversationId, conversationId))
    .orderBy(asc(conversationDocuments.id))
    .pipe(Effect.orDie);
  const [conversation] = yield* tx
    .select({ mode: conversations.mode })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .pipe(Effect.orDie);
  return {
    agent: agent ? { agentId: agent.agentId } : null,
    agentDrafts: drafts.filter((draft) => draft.kind === "agent").map(draftSummary),
    scheduleDrafts: drafts.filter((draft) => draft.kind === "schedule").map(draftSummary),
    documents,
    mode: conversation?.mode ?? "chat",
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
    }): Effect.Effect<{
      conversations: ConversationListRow[];
      nextCursor: ConversationCursor | null;
    }>;
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
    chunksAfter(messageId: string, afterSeq: number): Effect.Effect<ChunkRow[]>;
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
    listToolCalls(messageIds: ReadonlyArray<string>): Effect.Effect<ToolCallRow[]>;
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
                eq(conversations.userId, input.userId),
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
                      .reverse()
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
                  ? { agent: association, mode: conversation.mode }
                  : conversationCreated
                    ? { agent: null, mode: conversation.mode }
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
                  .set({ modelId: input.modelId, lastMessageAt: new Date(), updatedAt: new Date() })
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
            return yield* db
              .transaction((tx) =>
                Effect.gen(function* () {
                  // Ownership gates everything below, not just the final
                  // delete. The attachment release must never run for a
                  // conversation the caller does not own.
                  const owned = yield* tx
                    .select({ id: conversations.id })
                    .from(conversations)
                    .where(
                      and(eq(conversations.id, conversationId), eq(conversations.userId, userId)),
                    )
                    .for("update");
                  if (owned.length === 0) return [] as ReadonlyArray<string>;
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
                  return [...keys, ...queuedKeys];
                }),
              )
              .pipe(Effect.orDie);
          },
        ),

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

                const branchRows = yield* tx
                  .insert(conversations)
                  .values({
                    id: uuidv7(),
                    userId: source.userId,
                    // Whatever the locked row says is used: a title that resolved
                    // between the service's read and this lock counts.
                    title: source.title,
                    modelId: source.modelId,
                    // A branch of a work chat is still work: its history is
                    // full of folder activity the continuation has to match.
                    // The approval level is a fact about the chat too.
                    mode: source.mode,
                    permissionLevel: source.permissionLevel,
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
                          : call.result,
                        messageId: clonedIds.get(call.messageId)!,
                      })),
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

                const attachmentIds = yield* attachments.cloneForMessages(tx, {
                  userId: input.userId,
                  messages: [...clonedIds].map(([sourceMessageId, targetMessageId]) => ({
                    sourceMessageId,
                    targetMessageId,
                  })),
                });
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
                return branch;
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
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              // The periodic flusher calls this with an empty batch; renewing
              // before the early return is what keeps the lease alive between
              // chunks. The fence above makes a late renewal impossible.
              yield* db
                .update(messages)
                .set({ generationLeaseUntil: sql`clock_timestamp() + ${GENERATION_LEASE}` })
                .where(eq(messages.id, messageId))
                .pipe(Effect.orDie);
              if (chunks.length === 0) return;
              yield* db
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
                  const joined = (kind: "text" | "reasoning") =>
                    chunks
                      .filter((chunk) => chunk.kind === kind)
                      .map((chunk) => chunk.delta)
                      .join("");
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

        chunksAfter: Effect.fn("ChatRepo.chunksAfter")(function* (messageId, afterSeq) {
          return yield* db
            .select({
              seq: messageChunks.seq,
              kind: messageChunks.kind,
              delta: messageChunks.delta,
            })
            .from(messageChunks)
            .where(and(eq(messageChunks.messageId, messageId), gt(messageChunks.seq, afterSeq)))
            .orderBy(asc(messageChunks.seq))
            .pipe(Effect.orDie);
        }),

        insertToolCall: Effect.fn("ChatRepo.insertToolCall")(function* (input) {
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              yield* db
                .insert(messageToolCalls)
                .values({ ...input, status: "running" })
                .pipe(Effect.orDie);
            }),
          );
        }),

        settleToolCall: Effect.fn("ChatRepo.settleToolCall")(function* (input) {
          return yield* generationWrite((db) =>
            db
              .update(messageToolCalls)
              .set({ status: input.status, error: input.error, completedAt: new Date() })
              .where(eq(messageToolCalls.id, input.id))
              .pipe(Effect.orDie, Effect.asVoid),
          );
        }),
        completeToolCall: Effect.fn("ChatRepo.completeToolCall")(function* (input) {
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              yield* db
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

        failRunningToolCalls: Effect.fn("ChatRepo.failRunningToolCalls")(
          function* (messageId, message) {
            return yield* generationWrite((db) =>
              Effect.gen(function* () {
                yield* db
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
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              yield* db
                .insert(messageCompactionEvents)
                .values({ ...input, status: "running" })
                .pipe(Effect.orDie);
            }),
          );
        }),

        completeCompactionEvent: Effect.fn("ChatRepo.completeCompactionEvent")(function* (input) {
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              yield* db
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
            return yield* generationWrite((db) =>
              Effect.gen(function* () {
                yield* db
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
              const joined = (kind: "text" | "reasoning") =>
                chunks
                  .filter((chunk) => chunk.kind === kind)
                  .map((chunk) => chunk.delta)
                  .join("");
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
          return yield* generationWrite((db) =>
            Effect.gen(function* () {
              yield* db
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
                yield* db
                  .insert(usageEvents)
                  .values({ id: uuidv7(), ...input.ledger })
                  .pipe(Effect.orDie);
                yield* db
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
                  .delete(conversationDocuments)
                  .where(eq(conversationDocuments.createdByMessageId, input.messageId))
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
                  .set({ modelId: input.modelId, updatedAt: new Date() })
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
