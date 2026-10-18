import { GenerationFence, lockGeneration } from "../generation-fence.ts";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  conversationQueueEntries,
  messages,
  workTurnReservations,
} from "~/db/schema/index.ts";
import { ownedConversationById } from "../owned-conversation.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import {
  ConversationNotFound,
  NoActiveGeneration,
  QueueEntryNotFound,
  QueueFull,
} from "../../errors.ts";
import { requireEligibleAccount } from "~/modules/auth/server/account-eligibility.ts";
import { turnMessagesOf, questionForMessage } from "./questions.ts";
import type { RepoContext } from "./context.ts";
import type { SteeredMessage, ChatRepo } from "../repo.ts";

/** How many messages may wait behind one answer. */
export const QUEUE_LIMIT = 10;

/**
 * Whether a conversation's queue may move, read the one way promotion and the
 * queue strip both use, so what the strip says is what promotion will do.
 */
export const readQueueGate = Effect.fn("ChatRepo.readQueueGate")(function* (
  tx: Pick<DbTx, "select">,
  conversationId: string,
) {
  const streaming = yield* tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.status, "streaming")))
    .pipe(Effect.orDie);
  if (streaming.length > 0) return "busy" as const;
  // A send with workspace files holds its turn before any message exists.
  const reserved = yield* tx
    .select({ id: workTurnReservations.id })
    .from(workTurnReservations)
    .where(
      and(
        eq(workTurnReservations.conversationId, conversationId),
        eq(workTurnReservations.status, "reserved"),
        sql`${workTurnReservations.expiresAt} > now()`,
      ),
    )
    .limit(1)
    .pipe(Effect.orDie);
  if (reserved.length > 0) return "busy" as const;
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
export const queueOrder = [
  sql`${conversationQueueEntries.steerMessageId} is null`,
  asc(conversationQueueEntries.id),
] as const;

/** The queue's one lock: every queue write serializes on its conversation. */
const lockOwnedConversation = (tx: DbTx, userId: string, conversationId: string) =>
  Effect.gen(function* () {
    const owned = yield* tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(ownedConversationById(conversationId, userId))
      .for("update")
      .pipe(Effect.orDie);
    if (owned.length === 0) return yield* new ConversationNotFound({ conversationId });
  });

export const queueMethods = ({ db, attachments }: RepoContext) =>
  ({
    setQueueEntryError: Effect.fn("ChatRepo.setQueueEntryError")(
      function* (entryId, revision, message) {
        yield* db
          .update(conversationQueueEntries)
          .set({ lastError: message })
          .where(
            and(
              eq(conversationQueueEntries.id, entryId),
              eq(conversationQueueEntries.revision, revision),
            ),
          )
          .pipe(Effect.orDie);
      },
    ),

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
            isNull(conversations.deletedAt),
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
                revision: sql`${conversationQueueEntries.revision} + 1`,
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
              .select({
                id: conversationQueueEntries.id,
                revision: conversationQueueEntries.revision,
              })
              .from(conversationQueueEntries)
              .where(
                and(
                  eq(conversationQueueEntries.id, input.entryId),
                  eq(conversationQueueEntries.conversationId, input.conversationId),
                ),
              )
              .pipe(Effect.orDie);
            if (!entry || entry.revision !== input.expectedRevision)
              return yield* new QueueEntryNotFound({ entryId: input.entryId });
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
              .set({
                steerMessageId: input.messageId,
                steerGenerationId: input.generationId,
                revision: sql`${conversationQueueEntries.revision} + 1`,
                lastError: null,
              })
              .where(eq(conversationQueueEntries.id, input.entryId))
              .pipe(Effect.orDie);
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),

    claimSteeredEntries: Effect.fn("ChatRepo.claimSteeredEntries")(function* (input) {
      const fence = yield* GenerationFence;
      if (!fence) return { steered: [] as Array<SteeredMessage>, held: false };
      if (input.conversationId !== fence.conversationId || input.messageId !== fence.messageId)
        return yield* Effect.interrupt;
      // A steer admits fresh input, but refusal must not fail the accepted
      // answer. Take the account lock before the generation's locks.
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const refusal = yield* requireEligibleAccount(tx, fence.userId).pipe(
              Effect.as(null),
              Effect.catchTag("AccountIneligible", Effect.succeed),
            );
            yield* lockGeneration(tx, fence);
            const matching = and(
              eq(conversationQueueEntries.conversationId, fence.conversationId),
              eq(conversationQueueEntries.steerMessageId, fence.messageId),
              eq(conversationQueueEntries.steerGenerationId, fence.generationId),
              isNull(conversationQueueEntries.lastError),
            );
            if (refusal) {
              const held = yield* tx
                .update(conversationQueueEntries)
                .set({
                  lastError:
                    "This account can’t start messages. Try Send now after access is restored.",
                })
                .where(matching)
                .returning({ id: conversationQueueEntries.id })
                .pipe(Effect.orDie);
              return { steered: [] as Array<SteeredMessage>, held: held.length > 0 };
            }
            const entries = yield* tx
              .select()
              .from(conversationQueueEntries)
              .where(matching)
              .orderBy(asc(conversationQueueEntries.id))
              .pipe(Effect.orDie);
            const steered: Array<SteeredMessage> = [];
            if (entries.length === 0) return { steered, held: false };
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
              steered.push({
                ...message!,
                queueEntryId: entry.id,
                ...(entry.input.openDocument ? { openDocument: entry.input.openDocument } : {}),
              });
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
            return { steered, held: false };
          }),
        )
        .pipe(Effect.catchTag("SqlError", Effect.die));
    }),
  }) satisfies Partial<ChatRepo["Service"]>;
