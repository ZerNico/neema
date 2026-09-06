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
import { projectResearchProgress } from "../research-schema.ts";
import { createResearchStore, queueResearch, type ResearchStore } from "./research/repo.ts";
import { researchRuns, researchTasks } from "~/db/schema/research.ts";
import { uuidv7 } from "uuidv7";
import { Db } from "~/server/db.ts";
import {
  conversationCompactionCheckpoints,
  conversations,
  messageChunks,
  messageAttachments,
  messageCompactionEvents,
  messages,
  messageToolCalls,
} from "~/db/schema/index.ts";
import type { JsonValue } from "~/db/schema/providers.ts";
import type { AttachmentNotAvailable } from "~/modules/attachments/errors.ts";
import { AttachmentRepo, type DbTx } from "~/modules/attachments/server/repo.ts";
import {
  BranchNotAllowed,
  ConversationBusy,
  ConversationNotFound,
  MessageNotFound,
  InvalidMessage,
  QuestionUnavailable,
} from "../errors.ts";

export type TurnContent =
  | { content: string; questionResponse?: never }
  | { content?: never; questionResponse: { callId: string; response: QuestionResponse } };

export type EditContent =
  | { content: string; questionResponse?: never }
  | { content?: never; questionResponse: QuestionResponse };

export type CreateTurnInput = {
  generationMode?: "chat" | "research" | undefined;
  userId: string;
  conversationId: string | null;
  modelId: string;
  attachmentIds: ReadonlyArray<string>;
} & TurnContent;

export type ConversationRow = typeof conversations.$inferSelect;
/** A list row plus the live state the list surfaces (sidebar spinner). */
export type ConversationListRow = ConversationRow & { generating: boolean };
/** Position in the conversation list order: activity timestamp, then id. */
export interface ConversationCursor {
  readonly activity: Date;
  readonly id: string;
}
export type MessageRow = typeof messages.$inferSelect;
export type HistorySnapshot = ReadonlyArray<
  Pick<
    MessageRow,
    | "id"
    | "status"
    | "content"
    | "questionResponse"
    | "editedAt"
    | "completedAt"
    | "generationMode"
    | "researchRunId"
  >
>;

const matchesHistory = (actual: HistorySnapshot, expected: HistorySnapshot): boolean =>
  actual.length === expected.length &&
  actual.every((message, index) => {
    const previous = expected[index]!;
    return (
      message.id === previous.id &&
      message.status === previous.status &&
      message.generationMode === previous.generationMode &&
      message.researchRunId === previous.researchRunId &&
      message.content === previous.content &&
      JSON.stringify(message.questionResponse) === JSON.stringify(previous.questionResponse) &&
      message.editedAt?.getTime() === previous.editedAt?.getTime() &&
      message.completedAt?.getTime() === previous.completedAt?.getTime()
    );
  });
export type ChunkKind = "text" | "reasoning" | "tool" | "compaction";
export type ChunkRow = { seq: number; kind: ChunkKind; delta: string };
// Durable tool-call projection safe for clients (summaries only, no page bodies).
export type ToolCallRow = typeof messageToolCalls.$inferSelect;
export type CompactionCheckpointRow = typeof conversationCompactionCheckpoints.$inferSelect;
export type CompactionEventRow = typeof messageCompactionEvents.$inferSelect;

// `%`, `_` and the escape character itself are literals when someone types
// them into a search box, not wildcards.
const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/g, "\\$&");

// Callers hold the conversation lock. Only one successful immutable batch can
// own the immediately following structured user response.
const questionForMessage = Effect.fn("ChatRepo.questionForMessage")(function* (
  tx: DbTx,
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
  const batch = previousResponse ? yield* questionForMessage(tx, current[index - 1]) : null;
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

export class ChatRepo extends Context.Service<
  ChatRepo,
  {
    research?: ResearchStore;
    /**
     * One page of a user's conversations, newest activity first. Ordered by
     * `coalesce(lastMessageAt, createdAt)` with `id` as a tiebreaker so the
     * order is total — the cursor rides on exactly that pair.
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
    /**
     * One atomic turn: resolve (or create) the conversation, write the user
     * message, claim its attachments, and open the assistant row. Claiming has
     * to share the transaction — an attachment another tab grabbed first must
     * take the whole turn down rather than leave a half-written one.
     */
    createTurn(input: CreateTurnInput): Effect.Effect<
      {
        conversation: ConversationRow;
        conversationCreated: boolean;
        userMessage: MessageRow;
        assistant: MessageRow;
      },
      | ConversationNotFound
      | ConversationBusy
      | AttachmentNotAvailable
      | QuestionUnavailable
      | InvalidMessage
    >;
    updateConversation(
      conversationId: string,
      patch: Partial<{ title: string; modelId: string; lastMessageAt: Date }>,
    ): Effect.Effect<void>;
    /**
     * Resolves a pending title. False when the row is gone or already titled —
     * a manual rename that landed first must not be overwritten.
     */
    setTitleIfPending(conversationId: string, title: string): Effect.Effect<boolean>;
    // Returns storage keys the caller must delete after the commit.
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
    }): Effect.Effect<ConversationRow, ConversationNotFound | MessageNotFound | BranchNotAllowed>;
    listMessages(conversationId: string): Effect.Effect<MessageRow[]>;
    insertMessage(input: {
      conversationId: string;
      role: "user" | "assistant" | "system";
      status?: "streaming" | "complete";
      content?: string;
      modelId?: string;
    }): Effect.Effect<MessageRow>;
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
    // Marks calls stuck in "running" as failed (crash/fatal-error cleanup).
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
    // Marks an interrupted compaction terminal alongside interrupted tools.
    failRunningCompactionEvents(messageId: string, message: string): Effect.Effect<void>;
    listCompactionEvents(messageIds: ReadonlyArray<string>): Effect.Effect<CompactionEventRow[]>;
    finalizeMessage(input: {
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
    // Claims and wipes a finished assistant back to a fresh streaming state.
    // The claim, rewind deletes, and optional user edit commit atomically.
    resetMessageForRetry(input: {
      expectedMessages: HistorySnapshot;
      userId: string;
      messageId: string;
      modelId: string;
      deleteMessageIds: ReadonlyArray<string>;
      /**
       * Compaction boundaries this rewind invalidates. Deleted messages take
       * their checkpoints with them via cascade, but a retried assistant and
       * an edited user message keep their ids — a summary ending there now
       * describes text that no longer exists, so it has to go explicitly.
       */
      invalidateCheckpointThroughMessageIds: ReadonlyArray<string>;
      edit?: EditContent & {
        messageId: string;
        conversationId: string;
        attachmentIds: ReadonlyArray<string>;
      };
    }): Effect.Effect<
      { claimed: boolean; orphanedKeys: ReadonlyArray<string> },
      AttachmentNotAvailable | InvalidMessage
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
      },
    ): Effect.Effect<
      { message: MessageRow; orphanedKeys: ReadonlyArray<string> } | null,
      AttachmentNotAvailable | InvalidMessage
    >;
    // Removes messages entirely (chunks/tool calls go via FK cascade).
    // Returns storage keys to delete after the commit.
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

      return ChatRepo.of({
        research,
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
                // A title still being generated is null, so it matches nothing
                // — correct: there is not yet anything to match against.
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

        createTurn: Effect.fn("ChatRepo.createTurn")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                let conversationCreated = false;
                let conversation: ConversationRow;
                if (input.conversationId) {
                  // FOR UPDATE serializes turns per conversation, so two
                  // concurrent sends cannot both pass the streaming check.
                  const rows = yield* tx
                    .select()
                    .from(conversations)
                    .where(
                      and(
                        eq(conversations.id, input.conversationId),
                        eq(conversations.userId, input.userId),
                      ),
                    )
                    .for("update")
                    .pipe(Effect.orDie);
                  const row = rows[0];
                  if (!row) {
                    return yield* new ConversationNotFound({
                      conversationId: input.conversationId,
                    });
                  }
                  // Same rule retry/edit enforce: one generation at a time.
                  // A second tab sending mid-stream would otherwise start a
                  // generation whose history misses the in-flight answer.
                  const streaming = yield* tx
                    .select({ id: messages.id })
                    .from(messages)
                    .where(
                      and(eq(messages.conversationId, row.id), eq(messages.status, "streaming")),
                    )
                    .pipe(Effect.orDie);
                  if (streaming.length > 0) {
                    return yield* new ConversationBusy({ conversationId: row.id });
                  }
                  conversation = row;
                } else {
                  const rows = yield* tx
                    .insert(conversations)
                    // title stays null until generation resolves it.
                    .values({
                      id: uuidv7(),
                      userId: input.userId,
                      modelId: input.modelId,
                      title: null,
                    })
                    .returning()
                    .pipe(Effect.orDie);
                  conversation = rows[0]!;
                  conversationCreated = true;
                }

                let generationMode = input.generationMode ?? "chat";
                let content = input.content;
                let questionResponse: JsonValue | null = null;
                if (input.questionResponse) {
                  const { callId, response } = input.questionResponse;
                  if (!input.conversationId || input.attachmentIds.length > 0)
                    return yield* new QuestionUnavailable({ callId });
                  const tail = (yield* tx
                    .select()
                    .from(messages)
                    .where(eq(messages.conversationId, conversation.id))
                    .orderBy(desc(messages.createdAt), desc(messages.id))
                    .limit(1)
                    .pipe(Effect.orDie))[0];
                  const batch = yield* questionForMessage(tx, tail);
                  if (!batch || batch.call.id !== callId)
                    return yield* new QuestionUnavailable({ callId });
                  generationMode = tail?.generationMode ?? "chat";
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
                    generationMode,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                const userMessage = userRows[0]!;

                yield* attachments.reconcile(tx, {
                  userId: input.userId,
                  messageId: userMessage.id,
                  attachmentIds: input.attachmentIds,
                });

                const assistantRows = yield* tx
                  .insert(messages)
                  .values({
                    id: uuidv7(),
                    conversationId: conversation.id,
                    role: "assistant",
                    status: "streaming",
                    modelId: input.modelId,
                    generationMode,
                  })
                  .returning()
                  .pipe(Effect.orDie);

                if (generationMode === "research") {
                  assistantRows[0]!.researchRunId = yield* queueResearch(tx, {
                    userId: input.userId,
                    conversationId: conversation.id,
                    messageId: assistantRows[0]!.id,
                    modelId: input.modelId,
                  });
                }
                yield* tx
                  .update(conversations)
                  .set({ modelId: input.modelId, lastMessageAt: new Date(), updatedAt: new Date() })
                  .where(eq(conversations.id, conversation.id))
                  .pipe(Effect.orDie);

                return {
                  conversation,
                  conversationCreated,
                  userMessage,
                  assistant: assistantRows[0]!,
                };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
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
                  // delete — the attachment release must never run for a
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
                  // message_attachments cascades, but the attachment rows it
                  // points at do not — release them explicitly.
                  const keys = yield* attachments.releaseForMessages(
                    tx,
                    rows.map((row) => row.id),
                  );
                  yield* tx.delete(conversations).where(eq(conversations.id, conversationId));
                  return keys;
                }),
              )
              .pipe(Effect.orDie);
          },
        ),

        cloneConversationPrefix: Effect.fn("ChatRepo.cloneConversationPrefix")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
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
                const prefix = all.slice(0, index + 1);
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
                    // Whatever the locked row says — a title that resolved
                    // between the service's read and this lock counts.
                    title: source.title,
                    modelId: source.modelId,
                    branchedFrom: source.id,
                    // Left null so the branch sorts by its own createdAt (now)
                    // and lands at the top of the list, like a new chat.
                    lastMessageAt: null,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                const branch = branchRows[0]!;

                const clonedIds = new Map(prefix.map((m) => [m.id, uuidv7()] as const));
                yield* tx
                  .insert(messages)
                  .values(
                    prefix.map((m) => ({
                      ...m,
                      id: clonedIds.get(m.id)!,
                      conversationId: branch.id,
                      // createdAt/completedAt/editedAt stay as they were: the
                      // branch shows the same history, day dividers included.
                    })),
                  )
                  .pipe(Effect.orDie);

                const runIds = new Map<string, string>();
                const taskIds = new Map<string, string>();
                const clonedProgress = new Map<string, unknown>();
                for (const message of prefix) {
                  if (!message.researchRunId) continue;
                  const run = (yield* tx
                    .select()
                    .from(researchRuns)
                    .where(eq(researchRuns.id, message.researchRunId))
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
                  yield* tx
                    .update(messages)
                    .set({ researchRunId: id })
                    .where(eq(messages.id, clonedIds.get(message.id)!))
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

                yield* attachments.cloneForMessages(tx, {
                  userId: input.userId,
                  messages: [...clonedIds].map(([sourceMessageId, targetMessageId]) => ({
                    sourceMessageId,
                    targetMessageId,
                  })),
                });

                // Compaction checkpoints follow the prefix they describe. Only
                // those whose boundary is inside the copied range are eligible
                // — a summary ending past the branch point covers messages
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

                // message_chunks are deliberately not copied — they exist so a
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
          const rows = yield* db
            .insert(messages)
            .values({
              id: uuidv7(),
              conversationId: input.conversationId,
              role: input.role,
              status: input.status ?? "complete",
              content: input.content ?? "",
              modelId: input.modelId,
            })
            .returning()
            .pipe(Effect.orDie);
          return rows[0]!;
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
          if (chunks.length === 0) return;
          yield* db
            .insert(messageChunks)
            .values(chunks.map((c) => ({ messageId, seq: c.seq, kind: c.kind, delta: c.delta })))
            .pipe(Effect.orDie);
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
          yield* db
            .insert(messageToolCalls)
            .values({ ...input, status: "running" })
            .pipe(Effect.orDie);
        }),

        completeToolCall: Effect.fn("ChatRepo.completeToolCall")(function* (input) {
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

        failRunningToolCalls: Effect.fn("ChatRepo.failRunningToolCalls")(
          function* (messageId, message) {
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
          yield* db
            .insert(messageCompactionEvents)
            .values({ ...input, status: "running" })
            .pipe(Effect.orDie);
        }),

        completeCompactionEvent: Effect.fn("ChatRepo.completeCompactionEvent")(function* (input) {
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

        failRunningCompactionEvents: Effect.fn("ChatRepo.failRunningCompactionEvents")(
          function* (messageId, message) {
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

        finalizeMessage: Effect.fn("ChatRepo.finalizeMessage")(function* (input) {
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
                const claimed = yield* tx
                  .update(messages)
                  .set({
                    status: "streaming",
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

                if (current[index]!.generationMode === "research") {
                  yield* queueResearch(tx, {
                    userId: input.userId,
                    conversationId: target.conversationId,
                    messageId: input.messageId,
                    modelId: input.modelId,
                  });
                }
                const orphanedKeys: string[] = [];

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
                yield* tx
                  .delete(messageCompactionEvents)
                  .where(eq(messageCompactionEvents.messageId, input.messageId))
                  .pipe(Effect.orDie);

                return { claimed: true, orphanedKeys: orphanedKeys as ReadonlyArray<string> };
              }),
            )
            .pipe(Effect.catchTag("SqlError", Effect.die));
        }),

        createAssistantForEdit: Effect.fn("ChatRepo.createAssistantForEdit")(function* (input) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
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
                    modelId: input.modelId,
                    generationMode: current[index]!.generationMode,
                  })
                  .returning()
                  .pipe(Effect.orDie);
                if (current[index]!.generationMode === "research")
                  created[0]!.researchRunId = yield* queueResearch(tx, {
                    userId: input.userId,
                    conversationId: input.conversationId,
                    messageId: created[0]!.id,
                    modelId: input.modelId,
                  });
                return {
                  message: created[0]!,
                  orphanedKeys: orphanedKeys as ReadonlyArray<string>,
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
