import { notifyOnCommit } from "~/modules/sync/server/signals.ts";
import { and, eq, inArray, isNotNull, max, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  messageCompactionEvents,
  messages,
  messageToolCalls,
  models,
  researchRuns,
  researchTasks,
  researchCalls,
  usageEvents,
} from "~/db/schema/index.ts";
import type { Db } from "~/server/db.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { InvalidMessage } from "../../errors.ts";
import { projectResearchProgress, type ResearchProgress } from "../../research-schema.ts";
import { emptyUsageTotals, resolveCost } from "~/modules/analytics/server/usage.ts";

export type ResearchFence = {
  runId: string;
  messageId: string;
  conversationId: string;
  /** The attempt that started the run; a retry or edit mints a new one. */
  generationId: string;
  owner: string;
};
export const initialResearchProgress = (runId: string, title?: string): ResearchProgress => ({
  runId,
  ...(title ? { title } : {}),
  phase: "queued",
  tasks: [],
  limitations: [],
  usageComplete: true,
});

/** Caller holds conversation lock. User advisory lock orders admission across conversations. */
const queueResearch = Effect.fn("research.queue")(function* (
  tx: DbTx,
  input: {
    userId: string;
    conversationId: string;
    messageId: string;
    generationId: string;
    toolCallId: string;
    modelId: string;
    title?: string;
  },
) {
  yield* tx
    .execute(sql`select pg_advisory_xact_lock(hashtextextended(${input.userId}, 82417))`)
    .pipe(Effect.orDie);
  const active = yield* tx
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .where(
      and(
        eq(researchRuns.userId, input.userId),
        inArray(researchRuns.status, ["queued", "running"]),
      ),
    )
    .pipe(Effect.orDie);
  if (active.length)
    return yield* new InvalidMessage({
      reason: "You already have an active deep research request. Stop it or wait for it to finish.",
    });
  const id = uuidv7();
  // Nothing is written to the message: a run is a unit of work owned by its
  // tool call, fenced by the generation that started it.
  yield* tx
    .insert(researchRuns)
    .values({
      id,
      userId: input.userId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      generationId: input.generationId,
      toolCallId: input.toolCallId,
      modelId: input.modelId,
      modelName: input.modelId,
      progress: initialResearchProgress(id, input.title),
    })
    .pipe(Effect.orDie);
  return id;
});

/** Reuse inside an existing write transaction; never wrap another repository transaction in locked. */
export const lockResearchFence = Effect.fn("research.lockFence")(function* (
  tx: DbTx,
  fence: ResearchFence,
  allowCancelled = false,
) {
  const conversation = yield* tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, fence.conversationId))
    .for("update")
    .pipe(Effect.orDie);
  const valid = yield* tx
    .select({ id: researchRuns.id })
    .from(researchRuns)
    .innerJoin(messages, eq(messages.id, researchRuns.messageId))
    .where(
      and(
        eq(researchRuns.id, fence.runId),
        eq(researchRuns.conversationId, fence.conversationId),
        eq(researchRuns.messageId, fence.messageId),
        eq(researchRuns.generationId, fence.generationId),
        eq(researchRuns.owner, fence.owner),
        eq(researchRuns.status, "running"),
        eq(messages.conversationId, fence.conversationId),
        eq(messages.generationId, fence.generationId),
        eq(messages.status, "streaming"),
        sql`${researchRuns.leaseUntil} > clock_timestamp()`,
        ...(allowCancelled ? [] : [eq(researchRuns.cancelRequested, false)]),
      ),
    )
    .pipe(Effect.orDie);
  if (!conversation.length || !valid.length)
    return yield* Effect.die(new Error("Research ownership lost or cancelled"));
});

export const createResearchStore = (db: Db["Service"]) => {
  const locked = <A, E>(
    fence: ResearchFence,
    work: (tx: DbTx) => Effect.Effect<A, E>,
    allowCancelled = false,
  ) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* lockResearchFence(tx, fence, allowCancelled);
          return yield* work(tx);
        }),
      )
      .pipe(Effect.catchTag("SqlError", Effect.die));

  const finalizeTx = Effect.fn("research.finalizeTx")(function* (
    tx: DbTx,
    run: typeof researchRuns.$inferSelect,
    phase: ResearchProgress["phase"],
  ) {
    if (run.cancelRequested) phase = "aborted";
    if (run.status === "terminal") return false;
    const calls = yield* tx
      .select()
      .from(researchCalls)
      .where(eq(researchCalls.runId, run.id))
      .pipe(Effect.orDie);
    const totals = emptyUsageTotals();
    const complete = calls
      .filter((call) => call.phase !== "compaction")
      .every((call) => call.usageComplete && call.status === "complete");
    for (const call of calls.filter((call) => call.phase === "compaction")) {
      const usage = call.usage ?? emptyUsageTotals();
      yield* tx
        .insert(usageEvents)
        .values({
          id: call.id,
          userId: run.userId,
          kind: "compaction",
          modelId: null,
          modelName: run.modelName,
          conversationId: run.conversationId,
          messageId: run.messageId,
          status: call.status === "complete" ? "complete" : "error",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          reasoningTokens: usage.reasoningTokens,
          usageComplete: call.usageComplete,
          ...(call.usageComplete
            ? resolveCost(usage, run.pricing)
            : { cost: null, costSource: null }),
        })
        .onConflictDoNothing()
        .pipe(Effect.orDie);
    }
    for (const call of calls) {
      if (!call.usage || call.phase === "compaction") continue;
      totals.inputTokens += call.usage.inputTokens;
      totals.outputTokens += call.usage.outputTokens;
      totals.cachedInputTokens += call.usage.cachedInputTokens;
      totals.reasoningTokens += call.usage.reasoningTokens;
      totals.sawUsage ||= call.usage.sawUsage;
      if (call.usage.providerCost !== null)
        totals.providerCost = (totals.providerCost ?? 0) + call.usage.providerCost;
    }
    if (calls.some((call) => call.phase !== "compaction" && call.usage?.providerCost == null))
      totals.providerCost = null;
    const status = phase === "aborted" ? "aborted" : phase === "complete" ? "complete" : "error";
    const progress = projectResearchProgress({
      ...run.progress,
      phase,
      usageComplete: complete,
      tasks: run.progress.tasks.map((task) =>
        task.status === "running" || task.status === "queued"
          ? { ...task, status: "aborted" }
          : task,
      ),
      limitations: complete
        ? run.progress.limitations
        : [
            ...run.progress.limitations,
            "Usage is incomplete: one or more provider calls ended without confirmed usage.",
          ],
    });
    yield* tx
      .update(researchRuns)
      .set({ status: "terminal", progress, owner: null, completedAt: new Date() })
      .where(eq(researchRuns.id, run.id))
      .pipe(Effect.orDie);
    yield* tx
      .update(researchTasks)
      .set({ status: "aborted" })
      .where(
        and(eq(researchTasks.runId, run.id), inArray(researchTasks.status, ["queued", "running"])),
      )
      .pipe(Effect.orDie);
    yield* tx
      .update(researchCalls)
      .set({ status: "error" })
      .where(and(eq(researchCalls.runId, run.id), eq(researchCalls.status, "running")))
      .pipe(Effect.orDie);
    // Run-scoped only. Ending a run must never touch the message or its other
    // rows: the run is one tool call inside a generation that continues after
    // it, and the generation's own completion path owns everything else. Its
    // own call is the exception, because the body there is the run's.
    if (run.toolCallId) {
      const row = (yield* tx
        .select({ result: messageToolCalls.result })
        .from(messageToolCalls)
        .where(eq(messageToolCalls.id, run.toolCallId))
        .pipe(Effect.orDie))[0];
      if (row)
        yield* tx
          .update(messageToolCalls)
          .set({
            result: JSON.parse(
              JSON.stringify({ ...(row.result as Record<string, unknown>), progress }),
            ),
          })
          .where(eq(messageToolCalls.id, run.toolCallId))
          .pipe(Effect.orDie);
    }
    const existingModel = (yield* tx
      .select({ id: models.id })
      .from(models)
      .where(eq(models.id, run.modelId))
      .pipe(Effect.orDie))[0];
    yield* tx
      .insert(usageEvents)
      .values({
        id: run.id,
        userId: run.userId,
        kind: "chat",
        modelId: existingModel?.id ?? null,
        modelName: run.modelName,
        conversationId: run.conversationId,
        messageId: run.messageId,
        status,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        cachedInputTokens: totals.cachedInputTokens,
        reasoningTokens: totals.reasoningTokens,
        usageComplete: complete,
        ...(complete ? resolveCost(totals, run.pricing) : { cost: null, costSource: null }),
      })
      .onConflictDoNothing()
      .pipe(Effect.orDie);
    yield* notifyOnCommit(tx, {
      scope: "user",
      userId: run.userId,
      event: {
        type: "message.status",
        conversationId: run.conversationId,
        messageId: run.messageId,
        status,
      },
    });
    return true;
  });
  const get = (runId: string) =>
    db
      .select()
      .from(researchRuns)
      .where(eq(researchRuns.id, runId))
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows[0] ?? null),
      );
  const finalize = (runId: string, phase: ResearchProgress["phase"], owner?: string) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const candidate = yield* get(runId);
          if (!candidate) return false;
          yield* tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, candidate.conversationId))
            .for("update")
            .pipe(Effect.orDie);
          const run = (yield* tx
            .select()
            .from(researchRuns)
            .where(eq(researchRuns.id, runId))
            .for("update")
            .pipe(Effect.orDie))[0];
          if (!run || run.status === "terminal" || (owner !== undefined && run.owner !== owner))
            return false;
          if (owner !== undefined) {
            const live = yield* tx
              .select({ id: researchRuns.id })
              .from(researchRuns)
              .innerJoin(messages, eq(messages.id, researchRuns.messageId))
              .where(
                and(
                  eq(researchRuns.id, runId),
                  eq(messages.generationId, run.generationId),
                  eq(messages.status, "streaming"),
                  sql`${researchRuns.leaseUntil} > clock_timestamp()`,
                ),
              )
              .pipe(Effect.orDie);
            if (!live.length) return false;
          }
          if (owner === undefined) {
            const expired = yield* tx
              .select({ id: researchRuns.id })
              .from(researchRuns)
              .where(
                and(
                  eq(researchRuns.id, runId),
                  sql`${researchRuns.leaseUntil} <= clock_timestamp()`,
                ),
              )
              .pipe(Effect.orDie);
            if (!expired.length) return false;
          }
          return yield* finalizeTx(tx, run, phase);
        }),
      )
      .pipe(Effect.orDie);
  // The highest position an earlier run on this message used. Runs never
  // overlap (one active per user), so the next one starts above it.
  const lastRunPosition = (fence: ResearchFence) =>
    locked(fence, (tx) =>
      Effect.all([
        tx
          .select({ value: max(messageToolCalls.turnIndex) })
          .from(messageToolCalls)
          .where(
            and(
              eq(messageToolCalls.messageId, fence.messageId),
              isNotNull(messageToolCalls.researchRunId),
              ne(messageToolCalls.researchRunId, fence.runId),
            ),
          ),
        tx
          .select({ value: max(messageCompactionEvents.beforeTurnIndex) })
          .from(messageCompactionEvents)
          .where(
            and(
              eq(messageCompactionEvents.messageId, fence.messageId),
              isNotNull(messageCompactionEvents.researchRunId),
              ne(messageCompactionEvents.researchRunId, fence.runId),
            ),
          ),
      ]).pipe(
        Effect.orDie,
        Effect.map(([calls, events]) =>
          Math.max(-1, calls[0]?.value ?? -1, events[0]?.value ?? -1),
        ),
      ),
    );
  return {
    locked,
    lastRunPosition,
    get,
    finalize,
    // Caller holds the owned conversation row lock. Checkpoint observed usage
    // before cascades remove the attempts; late owner writes then fail the fence.
    finalizeBeforeDelete: (tx: DbTx, conversationId: string) =>
      Effect.gen(function* () {
        const runs = yield* tx
          .select()
          .from(researchRuns)
          .where(
            and(
              eq(researchRuns.conversationId, conversationId),
              inArray(researchRuns.status, ["queued", "running"]),
            ),
          )
          .pipe(Effect.orDie);
        for (const run of runs) yield* finalizeTx(tx, run, "aborted");
      }),
    reap: () =>
      db
        .select({ id: researchRuns.id })
        .from(researchRuns)
        .where(
          and(
            inArray(researchRuns.status, ["queued", "running"]),
            sql`${researchRuns.leaseUntil} <= clock_timestamp()`,
          ),
        )
        .pipe(
          Effect.orDie,
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => finalize(row.id, "interrupted"), { discard: true }),
          ),
        ),
    /** A run started from inside a turn, rather than by the send that queued one. */
    queue: (input: {
      userId: string;
      conversationId: string;
      messageId: string;
      generationId: string;
      toolCallId: string;
      modelId: string;
      title?: string;
    }) =>
      db
        .transaction((tx) => queueResearch(tx, input))
        .pipe(Effect.catchTag("SqlError", Effect.die)),
    claim: (runId: string) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const owner = uuidv7();
            const rows = yield* tx
              .update(researchRuns)
              .set({
                status: "running",
                owner,
                leaseUntil: sql`clock_timestamp() + interval '60 seconds'`,
              })
              .where(
                and(
                  eq(researchRuns.id, runId),
                  eq(researchRuns.status, "queued"),
                  eq(researchRuns.snapshot, false),
                  eq(researchRuns.cancelRequested, false),
                  sql`${researchRuns.leaseUntil} > clock_timestamp()`,
                ),
              )
              .returning()
              .pipe(Effect.orDie);
            const run = rows[0];
            if (run)
              return run
                ? {
                    run,
                    fence: {
                      runId,
                      owner,
                      messageId: run.messageId,
                      conversationId: run.conversationId,
                      generationId: run.generationId,
                    },
                  }
                : null;
          }),
        )
        .pipe(Effect.orDie),
    heartbeat: (fence: ResearchFence) =>
      locked(fence, (tx) =>
        tx
          .update(researchRuns)
          .set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
          .where(eq(researchRuns.id, fence.runId))
          .pipe(Effect.orDie, Effect.asVoid),
      ),
    alive: (fence: ResearchFence) =>
      db
        .select({ id: researchRuns.id })
        .from(researchRuns)
        .where(
          and(
            eq(researchRuns.id, fence.runId),
            eq(researchRuns.owner, fence.owner),
            eq(researchRuns.status, "running"),
            eq(researchRuns.cancelRequested, false),
            sql`${researchRuns.leaseUntil} > clock_timestamp()`,
          ),
        )
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.length > 0),
        ),
    /**
     * Stop cancels whatever run this attempt started. The caller knows the
     * generation, never the run: a run is a tool call inside it, and a turn may
     * make several.
     */
    cancelForGeneration: (messageId: string, generationId: string) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const candidate = (yield* tx
              .select()
              .from(researchRuns)
              .where(
                and(
                  eq(researchRuns.messageId, messageId),
                  eq(researchRuns.generationId, generationId),
                  inArray(researchRuns.status, ["queued", "running"]),
                ),
              )
              .pipe(Effect.orDie))[0];
            if (!candidate) return false;
            const expectedRunId = candidate.id;
            yield* tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.id, candidate.conversationId))
              .for("update")
              .pipe(Effect.orDie);
            const run = (yield* tx
              .update(researchRuns)
              .set({ cancelRequested: true })
              .where(
                and(
                  eq(researchRuns.messageId, messageId),
                  eq(researchRuns.id, expectedRunId),
                  inArray(researchRuns.status, ["queued", "running"]),
                ),
              )
              .returning()
              .pipe(Effect.orDie))[0];
            if (!run) return false;
            if (run.status === "queued") yield* finalizeTx(tx, run, "aborted");
            return true;
          }),
        )
        .pipe(Effect.orDie),
  };
};
export type ResearchStore = ReturnType<typeof createResearchStore>;
