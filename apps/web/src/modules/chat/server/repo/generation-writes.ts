import { liveModelId } from "~/modules/analytics/server/repo.ts";
import { GenerationFence, lockGeneration } from "../generation-fence.ts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversationCompactionCheckpoints,
  conversations,
  messageChunks,
  messageCompactionEvents,
  messages,
  messageToolCalls,
  toolCallDebugArguments,
  usageEvents,
} from "~/db/schema/index.ts";
import { leaseFor } from "~/server/sql.ts";
import type { RepoContext } from "./context.ts";
import type { ChatRepo } from "../repo.ts";

// How long a streaming row may go without a heartbeat before it is treated as
// abandoned. Flushes run every 250ms, so this survives a slow provider call
// and a busy event loop but not a dead process.
const GENERATION_LEASE_SECONDS = 45;
const GENERATION_LEASE = sql`make_interval(secs => ${GENERATION_LEASE_SECONDS})`;
/**
 * Granted whenever a row enters "streaming", so a retry of an old row is not
 * judged by its original creation time. Renewed by every flush afterwards.
 */
export const freshLease = () => leaseFor(GENERATION_LEASE_SECONDS);
export const INTERRUPTED_MESSAGE = "The response was interrupted before it finished.";

/** An answer's text or reasoning as its chunks spell it, the way the reaper reads it. */
export const joinChunks = (
  chunks: ReadonlyArray<{ kind: string; delta: string }>,
  kind: "text" | "reasoning",
) =>
  chunks
    .filter((chunk) => chunk.kind === kind)
    .map((chunk) => chunk.delta)
    .join("");

export const generationWriteMethods = ({ db, generationWrite }: RepoContext) =>
  ({
    saveProviderReplay: (messageId, replay) =>
      generationWrite((tx) =>
        tx
          .update(messages)
          .set({ providerReplay: replay })
          .where(eq(messages.id, messageId))
          .pipe(Effect.orDie, Effect.asVoid),
      ),

    saveOpening: (messageId, opening) =>
      generationWrite((tx) =>
        tx
          .update(messages)
          .set({ opening })
          .where(eq(messages.id, messageId))
          .pipe(Effect.orDie, Effect.asVoid),
      ),

    appendChunks: Effect.fn("ChatRepo.appendChunks")(function* (messageId, chunks) {
      return yield* generationWrite((tx) =>
        Effect.gen(function* () {
          // The periodic flusher calls this with an empty batch; renewing
          // before the early return is what keeps the lease alive between
          // chunks. The fence above makes a late renewal impossible.
          yield* tx
            .update(messages)
            .set({ generationLeaseUntil: freshLease() })
            .where(eq(messages.id, messageId))
            .pipe(Effect.orDie);
          if (chunks.length === 0) return;
          yield* tx
            .insert(messageChunks)
            .values(chunks.map((c) => ({ messageId, seq: c.seq, kind: c.kind, delta: c.delta })))
            .pipe(Effect.orDie);
        }),
      );
    }),

    renewGenerationLease: Effect.fn("ChatRepo.renewGenerationLease")(
      function* (messageId, generationId) {
        yield* db
          .update(messages)
          .set({ generationLeaseUntil: freshLease() })
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
    sweepCompletedChunks: Effect.fn("ChatRepo.sweepCompletedChunks")(function* () {
      let swept = 0;
      // Bounded batches so a first run over a large backlog never holds one
      // long delete. Every answer's chunks start at seq 1, so that row finds
      // each answer once.
      for (let batch = 0; batch < 10; batch++) {
        const answers = yield* db
          .select({ id: messageChunks.messageId })
          .from(messageChunks)
          .innerJoin(messages, eq(messages.id, messageChunks.messageId))
          .where(
            and(
              eq(messageChunks.seq, 1),
              eq(messages.status, "complete"),
              sql`${messages.completedAt} <= now() - interval '1 hour'`,
            ),
          )
          .limit(500)
          .pipe(Effect.orDie);
        if (answers.length === 0) break;
        // Re-checked in the delete itself: a retry since the select has
        // reset the row, and its new chunks stay for their own hour.
        yield* db
          .delete(messageChunks)
          .where(
            inArray(
              messageChunks.messageId,
              db
                .select({ id: messages.id })
                .from(messages)
                .where(
                  and(
                    inArray(
                      messages.id,
                      answers.map((answer) => answer.id),
                    ),
                    eq(messages.status, "complete"),
                    sql`${messages.completedAt} <= now() - interval '1 hour'`,
                  ),
                ),
            ),
          )
          .pipe(Effect.orDie);
        swept += answers.length;
        if (answers.length < 500) break;
      }
      return swept;
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
          yield* tx.insert(usageEvents).values({
            id: uuidv7(),
            ...input.ledger,
            modelId: liveModelId(input.ledger.modelId),
          });
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
              .values({
                id: uuidv7(),
                ...input.ledger,
                modelId: liveModelId(input.ledger.modelId),
              })
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

    insertCompactionCheckpoint: Effect.fn("ChatRepo.insertCompactionCheckpoint")(function* (input) {
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
    }),
  }) satisfies Partial<ChatRepo["Service"]>;
