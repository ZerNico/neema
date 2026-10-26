import type { ToolFamily } from "~/modules/tools/families.ts";
import type { UsageEventInput } from "~/modules/analytics/server/repo.ts";
import type { ExternalOwner } from "~/modules/tools/server/external-completion.ts";
import type { SkillNotAvailable, SkillRejected } from "~/modules/skills/errors.ts";
import { lockGenerationOutput, type GenerationIdentity } from "./generation-fence.ts";
import {
  lookupsOf,
  type UiImages,
  type UiLookups,
  type UiPlaces,
  type UiRoutes,
} from "../assistant-output.ts";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
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
import { Context, Effect, Layer } from "effect";
import { type AskUserParams, QuestionResponse } from "~/modules/tools/ask-user-schema.ts";
import type { QueuedTurnInput } from "../queued-turn.ts";
import { DELETED_CHAT_GRACE_SECONDS, TEMPORARY_CHAT_HOURS, type OpenDocument } from "../schema.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";
import type { ResearchStore } from "./research/repo.ts";
import { uuidv7 } from "uuidv7";
import {
  conversationCompactionCheckpoints,
  conversations,
  conversationQueueEntries,
  messageChunks,
  messageCompactionEvents,
  messageGenerationConfig,
  messages,
  messageToolCalls,
  messageUiStates,
  schedules,
} from "~/db/schema/index.ts";
import { deleteMark, ownedConversation, ownedConversationById } from "./owned-conversation.ts";
import type { ResolvedAgentConfig, UnavailableAgentDependency } from "~/db/schema/agents.ts";
import type { ResolvedProject } from "~/modules/projects/schema.ts";
import type { AgentNotAvailable } from "~/modules/agents/errors.ts";
import type { KnowledgeNotAvailable, KnowledgeRejected } from "~/modules/knowledge/errors.ts";
import type { ManifestEntry } from "~/modules/knowledge/server/repo.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { AttachmentNotAvailable } from "~/modules/attachments/errors.ts";
import type { Attachment } from "~/modules/attachments/schema.ts";
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
} from "../errors.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";
import type { AccountIneligible } from "~/modules/auth/server/account-eligibility.ts";
import type { IntegrationNotAvailable } from "~/modules/integrations/errors.ts";
import {
  PLAIN_GENERATION,
  readDefaults,
  readConfig,
  writeConfig,
} from "./repo/generation-config.ts";
import { turnMessagesOf, questionForMessage } from "./repo/questions.ts";
import { makeRepoContext } from "./repo/context.ts";
import { attemptClaimMethods } from "./repo/attempt-claims.ts";
import { branchMethods } from "./repo/branch.ts";
import { freshLease, generationWriteMethods } from "./repo/generation-writes.ts";
import { queueMethods, type QueueGate } from "./repo/queue.ts";
import type { DbTx } from "~/server/db.ts";
import type { UsageLimitReached } from "~/modules/limits/errors.ts";
export { PLAIN_GENERATION } from "./repo/generation-config.ts";
export { QUEUE_LIMIT, type QueueGate } from "./repo/queue.ts";
export { INTERRUPTED_MESSAGE, joinChunks } from "./repo/generation-writes.ts";

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
  /** The agent's dependencies this attempt ran without, empty or absent for none. */
  readonly agentUnavailable?: ReadonlyArray<UnavailableAgentDependency>;
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
  readonly desktopBrowser?: boolean;
  /** A schedule fire's up-front integration consent; null with a person present. */
  readonly integrationGrants?: ReadonlyArray<IntegrationGrant> | null;
  /** The image model this attempt was offered; null or absent offers no image tool. */
  readonly imageModel?: { readonly id: string; readonly name: string } | null;
}
export interface DraftSummary {
  id: string;
  name: string;
  messageId: string;
}

/**
 * A message row that sorts before `id` in the conversation's total order
 * `(created_at, id)`. Compared in SQL: a JS Date drops the microseconds that
 * tell apart the rows of one turn.
 */

const positionBefore = (id: string) =>
  sql`(${messages.createdAt}, ${messages.id}) < (select position.created_at, position.id from ${messages} as position where position.id = ${id})`;

/** Chats a list may show: never temporary, never archived. */
const listedBy = (userId: string) =>
  and(
    ownedConversation(userId),
    eq(conversations.temporary, false),
    isNull(conversations.archivedAt),
  );

/** Chats search may find: archived ones too, marked, never temporary. */
const searchableBy = (userId: string) =>
  and(ownedConversation(userId), eq(conversations.temporary, false));

/**
 * Which of a person's other chats one chat may look into: never itself, and
 * only those in its own project, or only those in none, as projects keep
 * their work apart. Narrows `searchableBy`, never replaces it.
 */
export interface ChatScope {
  readonly excludeId: string;
  readonly projectId: string | null;
}
const withinScope = (scope: ChatScope | undefined) =>
  scope
    ? and(
        ne(conversations.id, scope.excludeId),
        scope.projectId === null
          ? isNull(conversations.projectId)
          : eq(conversations.projectId, scope.projectId),
      )
    : undefined;

/**
 * The messages a chat's history is read as: what the person and the model
 * said, settled as an attempt's history counts it (the `settled` filter and
 * steer grouping in `generation/attempt-context.ts`; change both together),
 * and never the attempt still being written or a steer delivered into it. A
 * steer whose answer did not settle went with that attempt.
 */
const historyMessage = (exceptMessageId: string | undefined) =>
  and(
    inArray(messages.role, ["user", "assistant"]),
    or(
      eq(messages.status, "complete"),
      and(
        ne(messages.status, "streaming"),
        sql`jsonb_array_length(coalesce(${messages.assistantOutput}->'files', '[]'::jsonb)) > 0`,
      ),
    ),
    sql`(${messages.steeredIntoMessageId} is null or exists (select 1 from ${messages} answer where answer.id = ${messages.steeredIntoMessageId} and (answer.status = 'complete' or (answer.status <> 'streaming' and jsonb_array_length(coalesce(answer.assistant_output->'files', '[]'::jsonb)) > 0))))`,
    exceptMessageId
      ? and(
          ne(messages.id, exceptMessageId),
          sql`${messages.steeredIntoMessageId} is distinct from ${exceptMessageId}`,
        )
      : undefined,
  );

/** One message as the history tools number it: its place among `historyMessage` rows. */
export interface HistoryMessage {
  number: number;
  role: "user" | "assistant";
  createdAt: Date;
  content: string;
}

/** The fixed association, not an agent configuration snapshot. */
export interface ConversationDefaults {
  readonly agent: { agentId: string | null } | null;
  /** The chat's project, re-authorized by every attempt; null outside one. */
  readonly projectId?: string | null;
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
  /** Set where defaults were read from a stored chat, so an attempt can move its image lock. */
  readonly conversationId?: string;
  /** The chat's image model lock; null when it has none or the model was deleted. */
  readonly imageModelId?: string | null;
}
export type ResolveError =
  | AccountIneligible
  | IntegrationNotAvailable
  | AgentNotAvailable
  | SkillNotAvailable
  | SkillRejected
  | KnowledgeNotAvailable
  | KnowledgeRejected
  | InvalidMessage
  | UsageLimitReached;
export type ResolveGeneration = (
  tx: DbTx,
  defaults: ConversationDefaults,
  continuation?: GenerationConfig,
) => Effect.Effect<GenerationConfig, ResolveError>;

/** Everything about a turn except its content; `CreateTurnInput` adds that. */
export type ConversationReference =
  | {
      readonly kind: "new";
      readonly id: string;
      readonly temporary?: boolean | undefined;
      readonly projectId?: string | undefined;
    }
  | { readonly kind: "existing"; readonly id: string };

export type TurnFields = {
  userId: string;
  conversation: ConversationReference;
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
  /** Composer choices are saved with the turn, before its attempt is opened. */
  saveIntegrationChoices?:
    | ((tx: DbTx, conversationId: string) => Effect.Effect<void, IntegrationNotAvailable>)
    | undefined;
  /** Settles the attempt's configuration inside its transaction. */
  resolve: ResolveGeneration;
  /** The connected app that sent this message, recorded on it for good. */
  origin?: { clientId: string; clientName: string } | undefined;
};
export type CreateTurnInput = TurnFields & TurnContent;

export type QueueEntry = typeof conversationQueueEntries.$inferSelect;
/** A queue row with its files, as the queue strip and dispatch read it. */
export type QueuedMessage = QueueEntry & { attachments: ReadonlyArray<Attachment> };

export type ConversationRow = typeof conversations.$inferSelect;
/** A list row plus the live state the list surfaces (sidebar spinner). */
/** One chat found by search; `messageId` and `snippet` are set when message text matched. */
export interface ChatSearchHit {
  conversationId: string;
  title: string | null;
  messageId: string | null;
  snippet: Snippet | null;
  archived: boolean;
  lastActivityAt: Date;
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
  "generationId" | "assistantOutput" | "providerReplay" | "opening"
> &
  Partial<Pick<StoredMessage, "generationId" | "assistantOutput" | "providerReplay" | "opening">>;
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

/**
 * A finished answer of the reader's own, still on the named attempt; null
 * otherwise. Locked, the conversation row is the one retry and edit take, so
 * a reset cannot slip between this check and the caller's write.
 */
const ownFinishedAnswer = Effect.fn("ChatRepo.ownFinishedAnswer")(function* (
  tx: DbTx,
  input: { userId: string; messageId: string; generationId: string | null; lock: boolean },
) {
  const [target] = yield* tx
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .pipe(Effect.orDie);
  if (!target) return null;
  const owner = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(ownedConversationById(target.conversationId, input.userId));
  const owned = yield* (input.lock ? owner.for("update") : owner).pipe(Effect.orDie);
  if (owned.length === 0) return null;
  const [message] = yield* tx
    .select({
      role: messages.role,
      status: messages.status,
      generationId: messages.generationId,
      content: messages.content,
      assistantOutput: messages.assistantOutput,
    })
    .from(messages)
    .where(eq(messages.id, input.messageId))
    .pipe(Effect.orDie);
  if (
    !message ||
    message.role !== "assistant" ||
    message.status === "streaming" ||
    message.generationId !== input.generationId
  ) {
    return null;
  }
  return message;
});

/** A steer as it joins the answer: its message, and the document it was sent from. */
export type SteeredMessage = MessageRow & {
  queueEntryId: string;
  openDocument?: OpenDocument | undefined;
};

const {
  providerReplay: _privateReplay,
  opening: _privateOpening,
  ...windowColumns
} = getTableColumns(messages);
export type WindowMessageRow = Omit<MessageRow, "providerReplay" | "opening">;

export class ChatRepo extends Context.Service<
  ChatRepo,
  {
    research?: ResearchStore;
    saveProviderReplay(
      messageId: string,
      replay: NonNullable<MessageRow["providerReplay"]>,
    ): Effect.Effect<void>;
    /** What the answer's first request carried after its user message. */
    saveOpening(
      messageId: string,
      opening: NonNullable<MessageRow["opening"]>,
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
      /** Set when one chat searches the others: see `ChatScope`. */
      scope?: ChatScope | undefined;
    }): Effect.Effect<ChatSearchHit[]>;
    /** Another chat `scope` lets this person read, or null. */
    findReadableChat(input: {
      userId: string;
      chatId: string;
      scope: ChatScope;
    }): Effect.Effect<{ id: string; title: string | null } | null>;
    /**
     * A page of a chat's history by message number, from 1, with how many
     * messages it has. Callers authorize the chat first.
     */
    readHistoryPage(input: {
      conversationId: string;
      exceptMessageId?: string | undefined;
      from: number;
      count: number;
    }): Effect.Effect<{ messages: HistoryMessage[]; total: number }>;
    /** Messages of one chat matching `query`, in order from message `from`, with an excerpt each. */
    searchHistory(input: {
      conversationId: string;
      exceptMessageId?: string | undefined;
      query: string;
      from: number;
      limit: number;
    }): Effect.Effect<{
      hits: Array<Omit<HistoryMessage, "content"> & { snippet: Snippet }>;
      matches: number;
    }>;
    getConversation(
      userId: string,
      conversationId: string,
    ): Effect.Effect<ConversationRow, ConversationNotFound>;
    createConversation(input: { userId: string; modelId: string }): Effect.Effect<ConversationRow>;
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
      userId: string;
      conversationId: string;
      /**
       * The head the caller validated. A removal or edit can change it before
       * the lock is taken; the promotion then reports `changed` rather than
       * starting an entry nobody checked.
       */
      expectedEntryId: string;
      expectedRevision: number;
      /**
       * Start that entry even if it is not first: a person pressed Send now
       * on it. Otherwise only the head starts.
       */
      jumpQueue?: boolean | undefined;
      resolve: (entry: QueueEntry) => ResolveGeneration;
      /** A person asking explicitly may start after a stop or a failure. */
      force?: boolean | undefined;
    }): Effect.Effect<
      | {
          promoted: false;
          reason: "busy" | "unsettled" | "question" | "empty" | "changed" | "held";
        }
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
      userId?: string | undefined;
    }): Effect.Effect<Array<{ userId: string; conversationId: string }>>;
    setQueueEntryError(
      entryId: string,
      revision: number,
      message: string | null,
    ): Effect.Effect<void>;
    listQueue(conversationId: string): Effect.Effect<QueuedMessage[]>;
    /** See `readQueueGate`: whether the queue may move right now, and if not, why. */
    queueGate(conversationId: string): Effect.Effect<QueueGate>;
    enqueue(input: {
      userId: string;
      conversationId: string;
      content: string;
      input: QueuedTurnInput;
      attachmentIds: ReadonlyArray<string>;
      /** Absent when no session queued it; such an entry never counts as sent from a machine. */
      senderSessionId?: string | undefined;
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
      /** Absent when no session queued it; such an entry never counts as sent from a machine. */
      senderSessionId?: string | undefined;
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
      expectedRevision: number;
      messageId: string;
      generationId: string;
    }): Effect.Effect<void, ConversationNotFound | QueueEntryNotFound | NoActiveGeneration>;
    /**
     * Account-first, then under the generation fence: admits matching steers
     * with their files or holds them without failing the accepted answer.
     */
    claimSteeredEntries(input: {
      conversationId: string;
      messageId: string;
      /** The answer's text length at the boundary, where the steer renders. */
      textOffset: number;
      /** The model round the steer followed. */
      turnIndex: number;
    }): Effect.Effect<{ steered: Array<SteeredMessage>; held: boolean }>;
    getConversationDefaults(conversationId: string): Effect.Effect<ConversationDefaults>;
    /**
     * Private attempt execution record. Missing rows are an invariant violation;
     * no configuration is inferred from history or old tool calls.
     */
    getGenerationConfig(messageId: string): Effect.Effect<GenerationConfig>;
    listGenerationDisplay(messageIds: ReadonlyArray<string>): Effect.Effect<
      Array<{
        messageId: string;
        /** The collections the person chose, never the agent's: the agent is shown as itself. */
        collectionIds: ReadonlyArray<string>;
        skills?: ReadonlyArray<{ id: string; name: string }>;
        /** What of its agent the answer ran without; the answer says so. */
        agentUnavailable?: ReadonlyArray<Omit<UnavailableAgentDependency, "id">>;
      }>
    >;
    updateConversation(
      conversationId: string,
      patch: Partial<{
        title: string;
        modelId: string;
        lastMessageAt: Date;
      }>,
    ): Effect.Effect<void>;
    /** Clears the temporary flag. False when it was already a kept chat. */
    keepConversation(userId: string, conversationId: string): Effect.Effect<boolean>;
    /** Clears a scheduled run's unread mark. False when there was none. */
    markRead(userId: string, conversationId: string): Effect.Effect<boolean>;
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
    /** Answers still streaming in the chat, for a delete to stop. */
    listLiveAnswers(
      conversationId: string,
    ): Effect.Effect<ReadonlyArray<{ messageId: string; generationId: string | null }>>;
    /**
     * Marks an owned chat deleted and returns the mark, which names this
     * delete for its Undo; a chat already deleted keeps and returns its own.
     * Nothing is removed until the sweep purges it after its grace period.
     * Null when it was not there to delete.
     */
    trashConversation(userId: string, conversationId: string): Effect.Effect<string | null>;
    /**
     * Undoes the delete `mark` names, while the sweep has not purged it. False
     * when the chat is gone or was deleted again since: an old Undo must not
     * reverse a newer delete.
     */
    restoreConversation(
      userId: string,
      conversationId: string,
      mark: string,
    ): Effect.Effect<boolean>;
    /**
     * Chats due for purging, oldest first: deleted ones past their grace
     * period and temporary ones past their lifetime with no live answer.
     */
    listExpired(limit: number): Effect.Effect<ReadonlyArray<{ id: string }>>;
    /**
     * Purges the chat only if it is still due under the row lock, so a Keep,
     * an Undo or a new message landing after the listing wins. Null when it no
     * longer qualifies; otherwise its owner and the storage keys the caller
     * must delete after the commit.
     */
    purgeExpired(conversationId: string): Effect.Effect<{
      userId: string;
      keys: ReadonlyArray<string>;
      /** The chat's machine, which still holds its workspace. */
      machineId: string | null;
    } | null>;
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
    /**
     * Messages from `fromId` (or the start) up to, not including, `beforeId` (or
     * the end), for display: without provider replay, which is private and large.
     */
    listMessageWindow(
      conversationId: string,
      range: { fromId?: string | null; beforeId?: string },
    ): Effect.Effect<WindowMessageRow[]>;
    hasMessagesBefore(conversationId: string, messageId: string): Effect.Effect<boolean>;
    hasMessage(conversationId: string, messageId: string): Effect.Effect<boolean>;
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
    /**
     * The clarification a structured answer could reply to now: the tail
     * answer's one presented batch, by the same rule `createTurn` accepts.
     */
    openQuestion(conversationId: string): Effect.Effect<{
      callId: string;
      messageId: string;
      questions: AskUserParams["questions"];
    } | null>;
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
      /** Declared by the group that offered the tool; never inferred from the name. */
      family: ToolFamily;
      arguments: JsonValue;
      /** What a running call already knows, for a page that loads before it ends. */
      result?: JsonValue;
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
    /**
     * Drops the stream chunks of answers that completed over an hour ago, by the
     * database clock. Errored and stopped answers keep theirs for resume.
     */
    sweepCompletedChunks(): Effect.Effect<number>;
    listToolCalls(messageIds: ReadonlyArray<string>): Effect.Effect<ToolCallRow[]>;
    /** Saved ```ui block state for these answers; the client drops rows whose hash no longer matches. */
    listUiStates(messageIds: ReadonlyArray<string>): Effect.Effect<UiStateRow[]>;
    /**
     * Saves one block's state for the conversation's owner. Refused unless the
     * answer is finished, still on `generationId`, and its block `ordinal`
     * hashes to `sourceHash`: a late save from a replaced attempt changes nothing.
     * A branch's copy has no attempt (null) until it is retried.
     */
    saveUiState(input: {
      userId: string;
      messageId: string;
      generationId: string | null;
      ordinal: number;
      sourceHash: string;
      state: JsonValue;
      /** What the block showed; absent saves none. */
      digest?: string | null;
    }): Effect.Effect<"saved" | "refused">;
    /**
     * A finished answer's ```ui block source and its lookups so far, for the
     * page to ask for places and routes the block's state computes. Null when
     * the reader may not, as for a state save.
     */
    uiBlockForLookups(input: {
      userId: string;
      messageId: string;
      generationId: string | null;
      ordinal: number;
    }): Effect.Effect<{ code: string; lookups: UiLookups } | null>;
    /**
     * Adds lookups the page asked for to a finished answer, never replacing a
     * key it holds. Null when the answer moved on since they were asked.
     */
    recordPageLookups(input: {
      userId: string;
      messageId: string;
      generationId: string | null;
      places: UiPlaces;
      routes: UiRoutes;
    }): Effect.Effect<UiLookups | null>;
    /**
     * Merges what an answer's ```ui blocks looked up (images, places, routes)
     * into its output under the generation fence. Returns every result so far.
     */
    recordUiLookups(
      fence: GenerationIdentity,
      update: {
        readonly images?: UiImages;
        readonly places?: UiPlaces;
        readonly routes?: UiRoutes;
      },
    ): Effect.Effect<UiLookups>;
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
      resolve: ResolveGeneration;
    }): Effect.Effect<
      {
        claimed: boolean;
        orphanedKeys: ReadonlyArray<string>;
        generationId?: string | undefined;
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
      resolve: ResolveGeneration;
    }): Effect.Effect<
      { claimed: false } | { claimed: true; generationId: string },
      ResolveError | ConversationBusy
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
      const ctx = yield* makeRepoContext;
      const { db, attachments, research } = ctx;

      /**
       * A deleted chat past its grace period, or a temporary one a day past
       * its last activity, judged by the database clock. A deleted chat waits
       * out its grace whatever else holds, or its Undo could lose. A temporary
       * chat with an answer still inside its lease is left for the next pass
       * rather than deleted from under the generation; a deleted one had its
       * answer stopped by the delete.
       */
      const expired = or(
        sql`${conversations.deletedAt} < now() - make_interval(secs => ${DELETED_CHAT_GRACE_SECONDS})`,
        and(
          isNull(conversations.deletedAt),
          eq(conversations.temporary, true),
          sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}) < now() - make_interval(hours => ${TEMPORARY_CHAT_HOURS})`,
          sql`not exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id} and ${messages.status} = 'streaming' and ${messages.generationLeaseUntil} > now())`,
        ),
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
                .select({ userId: conversations.userId, machineId: conversations.machineId })
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
              return {
                userId: owned.userId,
                keys: [...keys, ...queuedKeys],
                machineId: owned.machineId,
              };
            }),
          )
          .pipe(Effect.orDie);

      /**
       * Newest matching message per chat among the user's most recent chats,
       * each checked back through its latest messages. Bounded work, and the
       * common case: a frequent term fills the page from recent chats without
       * touching every match in the history. Newest chats first.
       */
      const recentMatches = (searchable: SQL | undefined, query: SQL, limit: number) => {
        const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
        const recent = db
          .select({
            id: conversations.id,
            title: conversations.title,
            activity: sql<string>`${activity}`.as("recent_activity"),
          })
          .from(conversations)
          .where(searchable)
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
      const indexedMatches = (searchable: SQL | undefined, query: SQL, limit: number) =>
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
                    searchable,
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

      /** A chat's `historyMessage` rows with their numbers, in the conversation's total order. */
      const numberedHistory = (conversationId: string, exceptMessageId: string | undefined) =>
        db
          .select({
            role: sql<HistoryMessage["role"]>`${messages.role}`.as("history_role"),
            createdAt: sql<Date>`${messages.createdAt}`
              .mapWith(messages.createdAt)
              .as("history_created_at"),
            content: sql<string>`${messages.content}`.as("history_content"),
            number: sql<number>`row_number() over (order by ${messages.createdAt}, ${messages.id})`
              .mapWith(Number)
              .as("history_number"),
            total: sql<number>`count(*) over ()`.mapWith(Number).as("history_total"),
          })
          .from(messages)
          .where(and(eq(messages.conversationId, conversationId), historyMessage(exceptMessageId)))
          .as("numbered");

      return ChatRepo.of({
        ...generationWriteMethods(ctx),
        ...attemptClaimMethods(ctx),
        ...queueMethods(ctx),
        ...branchMethods(ctx),
        research,
        listConversations: Effect.fn("ChatRepo.listConversations")(function* (input) {
          const activity = sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`;
          const title = input.query?.trim();
          const rows = yield* db
            .select({
              ...getTableColumns(conversations),
              // Live per-row state for the list UIs: an answer is being
              // generated iff a message row is still streaming. Each
              // message.status flip patches the cached flag, without polling.
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
          const searchable = and(searchableBy(input.userId), withinScope(input.scope));
          const titled = yield* db
            .select({ conversationId: conversations.id, title: conversations.title })
            .from(conversations)
            .where(and(searchable, ilike(conversations.title, `%${escapeLike(needle)}%`)))
            .orderBy(desc(activity), desc(conversations.id))
            .limit(input.limit)
            .pipe(Effect.orDie);

          // Punctuation-only input has no terms, so only titles can match it;
          // titles alone may also fill the page, and they rank first anyway.
          const searchText = tsQuery !== null && titled.length < input.limit;
          const matched = searchText ? yield* recentMatches(searchable, query, input.limit) : [];
          const found =
            searchText && matched.length < input.limit
              ? yield* indexedMatches(searchable, query, input.limit)
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
          const stateRows = hits.length
            ? yield* db
                .select({
                  id: conversations.id,
                  archived: sql<boolean>`${conversations.archivedAt} is not null`,
                  lastActivityAt: sql<Date>`${activity}`.mapWith(conversations.createdAt),
                })
                .from(conversations)
                .where(
                  inArray(
                    conversations.id,
                    hits.map((hit) => hit.conversationId),
                  ),
                )
                .pipe(Effect.orDie)
            : [];
          const state = new Map(stateRows.map((row) => [row.id, row] as const));
          return hits.map((hit) => ({
            conversationId: hit.conversationId,
            title: hit.title,
            messageId: hit.messageId,
            snippet: (hit.messageId && snippets.get(hit.messageId)) || null,
            archived: state.get(hit.conversationId)?.archived ?? false,
            lastActivityAt: state.get(hit.conversationId)?.lastActivityAt ?? new Date(0),
          }));
        }),

        findReadableChat: Effect.fn("ChatRepo.findReadableChat")(function* (input) {
          const [row] = yield* db
            .select({ id: conversations.id, title: conversations.title })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, input.chatId),
                searchableBy(input.userId),
                withinScope(input.scope),
              ),
            )
            .pipe(Effect.orDie);
          return row ?? null;
        }),

        readHistoryPage: Effect.fn("ChatRepo.readHistoryPage")(function* (input) {
          const numbered = numberedHistory(input.conversationId, input.exceptMessageId);
          // One read, so the total and the page always describe the same messages.
          const rows = yield* db
            .select({
              number: numbered.number,
              role: numbered.role,
              createdAt: numbered.createdAt,
              content: numbered.content,
              total: numbered.total,
            })
            .from(numbered)
            .where(
              and(gte(numbered.number, input.from), lt(numbered.number, input.from + input.count)),
            )
            .orderBy(asc(numbered.number))
            .pipe(Effect.orDie);
          // Past the end there is no row to carry the total, so it is counted alone.
          const total =
            rows[0]?.total ??
            (yield* db
              .select({ total: sql<number>`count(*)`.mapWith(Number) })
              .from(numbered)
              .pipe(Effect.orDie))[0]?.total ??
            0;
          return { messages: rows.map(({ total: _total, ...message }) => message), total };
        }),

        searchHistory: Effect.fn("ChatRepo.searchHistory")(function* (input) {
          const tsQuery = prefixTsQuery(input.query);
          if (tsQuery === null) return { hits: [], matches: 0 };
          const query = sql`to_tsquery('app_search'::regconfig, ${tsQuery})`;
          const numbered = numberedHistory(input.conversationId, input.exceptMessageId);
          const matched = and(
            gte(numbered.number, input.from),
            sql`${messageSearchVector(numbered.content)} @@ ${query}`,
          );
          const rows = yield* db
            .select({
              number: numbered.number,
              role: numbered.role,
              createdAt: numbered.createdAt,
              // Counted before the limit, in the same read as the hits.
              matches: sql<number>`count(*) over ()`.mapWith(Number),
              headline: sql<string>`ts_headline('app_search'::regconfig, regexp_replace(regexp_replace(${numbered.content}, ${HEADLINE_NOISE}, '', 'g'), '[[:space:]]+', ' ', 'g'), ${query}, ${HEADLINE_OPTIONS})`,
            })
            .from(numbered)
            .where(matched)
            .orderBy(asc(numbered.number))
            .limit(input.limit)
            .pipe(Effect.orDie);
          return {
            hits: rows.map(({ headline, matches: _matches, ...hit }) => ({
              ...hit,
              snippet: snippetFromHeadline(headline),
            })),
            matches: rows[0]?.matches ?? 0,
          };
        }),

        getConversation: Effect.fn("ChatRepo.getConversation")(function* (userId, conversationId) {
          const rows = yield* db
            .select()
            .from(conversations)
            .where(ownedConversationById(conversationId, userId))
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

        getConversationDefaults: (conversationId) => readDefaults(db, conversationId),

        getGenerationConfig: (messageId) => readConfig(db, messageId),
        listGenerationDisplay: Effect.fn("ChatRepo.listGenerationDisplay")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          const rows = yield* db
            .select({
              messageId: messageGenerationConfig.messageId,
              // The person's picks the turn's agent did not also bring. Storage keeps
              // an overlapping pick, so a retry holds it if the agent later drops it.
              collectionIds: sql<string[]>`coalesce((
                select jsonb_agg(picked.id order by picked.ord)
                from jsonb_array_elements(${messageGenerationConfig.standaloneCollectionIds}) with ordinality as picked(id, ord)
                where not coalesce(${messageGenerationConfig.resolvedAgent}->'collectionIds', '[]'::jsonb) @> jsonb_build_array(picked.id)
              ), '[]'::jsonb)`,
              skills: sql<
                Array<{ id: string; name: string }>
              >`coalesce((select jsonb_agg(jsonb_build_object('id', entry->>'skillId', 'name', entry->>'name')) from jsonb_array_elements(${messageGenerationConfig.skills}) entry where (entry->>'explicit')::boolean), '[]'::jsonb)`,
              agentUnavailable: messageGenerationConfig.agentUnavailable,
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
                row.agentUnavailable.length > 0,
            )
            .map(({ agentUnavailable, ...row }) =>
              Object.assign(
                {},
                row,
                // Ids stay on the server: the line needs only the kind and a name.
                agentUnavailable.length > 0
                  ? {
                      agentUnavailable: agentUnavailable.map(({ kind, name }) => ({
                        kind,
                        name,
                      })),
                    }
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

        markRead: Effect.fn("ChatRepo.markRead")(function* (userId, conversationId) {
          const rows = yield* db
            .update(conversations)
            .set({ unread: false })
            .where(
              and(
                eq(conversations.id, conversationId),
                ownedConversation(userId),
                eq(conversations.unread, true),
              ),
            )
            .returning({ id: conversations.id })
            .pipe(Effect.orDie);
          return rows.length > 0;
        }),
        keepConversation: Effect.fn("ChatRepo.keepConversation")(
          function* (userId, conversationId) {
            const rows = yield* db
              .update(conversations)
              .set({ temporary: false, updatedAt: new Date() })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  ownedConversation(userId),
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
                  ownedConversation(userId),
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

        listLiveAnswers: Effect.fn("ChatRepo.listLiveAnswers")(function* (conversationId) {
          return yield* db
            .select({ messageId: messages.id, generationId: messages.generationId })
            .from(messages)
            .where(
              and(eq(messages.conversationId, conversationId), eq(messages.status, "streaming")),
            )
            .pipe(Effect.orDie);
        }),

        trashConversation: Effect.fn("ChatRepo.trashConversation")(
          function* (userId, conversationId) {
            // A chat already deleted keeps its mark: a repeated delete, a
            // retry or a second tab, names the same delete for its Undo.
            const [row] = yield* db
              .update(conversations)
              .set({ deletedAt: sql`coalesce(${conversations.deletedAt}, now())` })
              .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
              .returning({ mark: deleteMark })
              .pipe(Effect.orDie);
            return row?.mark ?? null;
          },
        ),

        restoreConversation: Effect.fn("ChatRepo.restoreConversation")(
          function* (userId, conversationId, mark) {
            const rows = yield* db
              .update(conversations)
              .set({ deletedAt: null })
              .where(
                and(
                  eq(conversations.id, conversationId),
                  eq(conversations.userId, userId),
                  eq(conversations.deletedAt, sql`${mark}::timestamptz`),
                ),
              )
              .returning({ id: conversations.id })
              .pipe(Effect.orDie);
            return rows.length > 0;
          },
        ),

        listExpired: Effect.fn("ChatRepo.listExpired")(function* (limit) {
          return yield* db
            .select({ id: conversations.id })
            .from(conversations)
            .where(expired)
            .orderBy(
              sql`coalesce(${conversations.deletedAt}, ${conversations.lastMessageAt}, ${conversations.createdAt})`,
            )
            .limit(limit)
            .pipe(Effect.orDie);
        }),

        purgeExpired: (conversationId) => deleteLocked(conversationId, expired),

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
              .select(windowColumns)
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
                ownedConversation(owner.userId),
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

        openQuestion: Effect.fn("ChatRepo.openQuestion")(function* (conversationId) {
          const [tail] = yield* db
            .select()
            .from(messages)
            .where(turnMessagesOf(conversationId))
            .orderBy(desc(messages.createdAt), desc(messages.id))
            .limit(1)
            .pipe(Effect.orDie);
          const batch = yield* questionForMessage(db, tail);
          return batch && tail
            ? { callId: batch.call.id, messageId: tail.id, questions: batch.questions }
            : null;
        }),
        getMessage: Effect.fn("ChatRepo.getMessage")(function* (messageId) {
          const rows = yield* db
            .select()
            .from(messages)
            .where(eq(messages.id, messageId))
            .pipe(Effect.orDie);
          return rows[0] ?? null;
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

        listUiStates: Effect.fn("ChatRepo.listUiStates")(function* (messageIds) {
          if (messageIds.length === 0) return [];
          return yield* db
            .select()
            .from(messageUiStates)
            .where(inArray(messageUiStates.messageId, [...messageIds]))
            .orderBy(asc(messageUiStates.messageId), asc(messageUiStates.ordinal))
            .pipe(Effect.orDie);
        }),

        recordUiLookups: Effect.fn("ChatRepo.recordUiLookups")(function* (fence, update) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const output = yield* lockGenerationOutput(tx, fence);
                const next = {
                  ...output,
                  v: 1 as const,
                  files: output?.files ?? [],
                  images: { ...output?.images, ...update.images },
                  places: { ...output?.places, ...update.places },
                  routes: { ...output?.routes, ...update.routes },
                };
                yield* tx
                  .update(messages)
                  .set({ assistantOutput: next })
                  .where(eq(messages.id, fence.messageId))
                  .pipe(Effect.orDie);
                return lookupsOf(next);
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        uiBlockForLookups: Effect.fn("ChatRepo.uiBlockForLookups")(function* (input) {
          if (
            !Number.isSafeInteger(input.ordinal) ||
            input.ordinal < 0 ||
            input.ordinal >= MAX_UI_BLOCKS
          ) {
            return null;
          }
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const message = yield* ownFinishedAnswer(tx, { ...input, lock: false });
                const fence = message ? scanUiFences(message.content)[input.ordinal] : undefined;
                if (!message || !fence?.closed) return null;
                return { code: fence.code, lookups: lookupsOf(message.assistantOutput) };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        recordPageLookups: Effect.fn("ChatRepo.recordPageLookups")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const message = yield* ownFinishedAnswer(tx, { ...input, lock: true });
                if (!message) return null;
                const output = message.assistantOutput;
                // What the answer holds wins: two tabs asking at once store one result.
                const next = {
                  ...output,
                  v: 1 as const,
                  files: output?.files ?? [],
                  places: { ...input.places, ...output?.places },
                  routes: { ...input.routes, ...output?.routes },
                };
                yield* tx
                  .update(messages)
                  .set({ assistantOutput: next })
                  .where(eq(messages.id, input.messageId))
                  .pipe(Effect.orDie);
                return lookupsOf(next);
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
                  .where(ownedConversationById(target.conversationId, input.userId))
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
                    digest: input.digest ?? null,
                  })
                  .onConflictDoUpdate({
                    target: [messageUiStates.messageId, messageUiStates.ordinal],
                    set: {
                      sourceHash: input.sourceHash,
                      state: input.state,
                      digest: input.digest ?? null,
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
      });
    }),
  );
}
