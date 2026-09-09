import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  messages,
  messageChunks,
  messageToolCalls,
  messageCompactionEvents,
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
  owner: string;
};
export const initialResearchProgress = (runId: string): ResearchProgress => ({
  runId,
  phase: "queued",
  tasks: [],
  limitations: [],
  usageComplete: true,
});

/** Caller holds conversation lock. User advisory lock orders admission across conversations. */
export const queueResearch = Effect.fn("research.queue")(function* (
  tx: DbTx,
  input: {
    userId: string;
    conversationId: string;
    messageId: string;
    modelId: string;
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
  yield* tx
    .insert(researchRuns)
    .values({ id, ...input, modelName: input.modelId, progress: initialResearchProgress(id) })
    .pipe(Effect.orDie);
  yield* tx
    .update(messages)
    .set({ researchRunId: id, generationMode: "research" })
    .where(eq(messages.id, input.messageId))
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
        eq(researchRuns.owner, fence.owner),
        eq(researchRuns.status, "running"),
        eq(messages.conversationId, fence.conversationId),
        eq(messages.researchRunId, fence.runId),
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
    const current = (yield* tx
      .select()
      .from(messages)
      .where(eq(messages.id, run.messageId))
      .pipe(Effect.orDie))[0];
    if (!current || current.researchRunId !== run.id || run.status === "terminal") return false;
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
    const status =
      phase === "aborted"
        ? "aborted"
        : ["complete", "awaiting_answer", "partial"].includes(phase)
          ? "complete"
          : "error";
    const chunks = yield* tx
      .select()
      .from(messageChunks)
      .where(eq(messageChunks.messageId, run.messageId))
      .orderBy(asc(messageChunks.seq))
      .pipe(Effect.orDie);
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
    yield* tx
      .update(messageToolCalls)
      .set({
        status: "error",
        completedAt: new Date(),
        error: { code: "ResearchEnded", message: phase },
      })
      .where(
        and(eq(messageToolCalls.messageId, run.messageId), eq(messageToolCalls.status, "running")),
      )
      .pipe(Effect.orDie);
    yield* tx
      .update(messageCompactionEvents)
      .set({
        status: "error",
        completedAt: new Date(),
        error: { code: "ResearchEnded", message: phase },
      })
      .where(
        and(
          eq(messageCompactionEvents.messageId, run.messageId),
          eq(messageCompactionEvents.status, "running"),
        ),
      )
      .pipe(Effect.orDie);
    const root = (yield* tx
      .select()
      .from(messageToolCalls)
      .where(eq(messageToolCalls.id, run.id))
      .pipe(Effect.orDie))[0];
    const result = (root?.result ?? {}) as Record<string, unknown>;
    if (!root)
      yield* tx
        .insert(messageToolCalls)
        .values({
          id: run.id,
          messageId: run.messageId,
          researchRunId: run.id,
          turnIndex: 0,
          callIndex: 0,
          textOffset: 0,
          providerCallId: run.id,
          toolName: "deep_research",
          arguments: {},
          result: { progress } as never,
          status: "running",
        })
        .pipe(Effect.orDie);
    yield* tx
      .update(messageToolCalls)
      .set({
        status: status === "complete" ? "complete" : "error",
        result: { ...result, progress } as never,
        completedAt: new Date(),
      })
      .where(eq(messageToolCalls.id, run.id))
      .pipe(Effect.orDie);
    yield* tx
      .insert(messageChunks)
      .values({
        messageId: run.messageId,
        seq: (chunks.at(-1)?.seq ?? 0) + 1,
        kind: "tool",
        delta: JSON.stringify({
          v: 1,
          family: "research",
          name: "deep_research",
          phase: "result",
          runId: run.id,
          callId: run.id,
          turnIndex: 0,
          callIndex: 0,
          textOffset: root?.textOffset ?? 0,
          progress,
        }),
      })
      .pipe(Effect.orDie);
    yield* tx
      .update(messages)
      .set({
        status,
        content: chunks
          .filter((c) => c.kind === "text")
          .map((c) => c.delta)
          .join(""),
        reasoning: chunks
          .filter((c) => c.kind === "reasoning")
          .map((c) => c.delta)
          .join(""),
        completedAt: new Date(),
        usage: { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens },
        error:
          status === "error"
            ? {
                tag: "ResearchInterrupted",
                message:
                  phase === "interrupted"
                    ? "Research was interrupted. Retry to start a new attempt."
                    : "Research could not be completed. Retained findings are available in the research activity.",
              }
            : null,
      })
      .where(eq(messages.id, run.messageId))
      .pipe(Effect.orDie);
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
              .where(
                and(
                  eq(researchRuns.id, runId),
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
  return {
    locked,
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
    claim: (runId: string) =>
      Effect.gen(function* () {
        const owner = uuidv7();
        const rows = yield* db
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
        return run
          ? {
              run,
              fence: { runId, owner, messageId: run.messageId, conversationId: run.conversationId },
            }
          : null;
      }),
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
    cancel: (messageId: string, expectedRunId: string) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const candidate = yield* get(expectedRunId);
            if (!candidate || candidate.messageId !== messageId) return false;
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
    tail: (messageId: string, afterSeq: number) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const target = (yield* tx
              .select()
              .from(messages)
              .where(eq(messages.id, messageId))
              .pipe(Effect.orDie))[0];
            if (!target) return null;
            yield* tx
              .select({ id: conversations.id })
              .from(conversations)
              .where(eq(conversations.id, target.conversationId))
              .for("update")
              .pipe(Effect.orDie);
            const message = (yield* tx
              .select()
              .from(messages)
              .where(eq(messages.id, messageId))
              .pipe(Effect.orDie))[0];
            if (!message) return null;
            const chunks = yield* tx
              .select()
              .from(messageChunks)
              .where(
                and(
                  eq(messageChunks.messageId, messageId),
                  sql`${messageChunks.seq} > ${afterSeq}`,
                ),
              )
              .orderBy(asc(messageChunks.seq))
              .pipe(Effect.orDie);
            return { message, chunks };
          }),
        )
        .pipe(Effect.orDie),
  };
};
export type ResearchStore = ReturnType<typeof createResearchStore>;
