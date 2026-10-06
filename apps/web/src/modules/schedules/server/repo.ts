import { and, asc, desc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import { conversations, scheduleRuns, schedules } from "~/db/schema/index.ts";
import type { DbTx } from "~/modules/attachments/server/repo.ts";
import { Db } from "~/server/db.ts";
import type { ScheduleRunSummary, ScheduleSummary } from "../schema.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

export type ScheduleRow = typeof schedules.$inferSelect;
type RunRow = typeof scheduleRuns.$inferSelect;

export const toSummary = (row: ScheduleRow): ScheduleSummary => ({
  id: row.id,
  name: row.name,
  scheduleText: row.scheduleText,
  cron: row.cron,
  timezone: row.timezone,
  paused: row.paused,
  nextFireAt: row.nextFireAt?.toISOString() ?? null,
  lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
});

const CLAIM_BATCH = 25;

export class ScheduleRepo extends Context.Service<
  ScheduleRepo,
  {
    list(userId: string): Effect.Effect<ScheduleRow[]>;
    get(userId: string, scheduleId: string, tx?: DbTx): Effect.Effect<ScheduleRow | null>;
    insert(
      input: {
        userId: string;
        name: string;
        prompt: string;
        scheduleText: string;
        cron: string;
        timezone: string;
        endAt: Date | null;
        modelId: string | null;
        agentId: string | null;
        searchEnabled: boolean;
        researchEnabled: boolean;
        collectionIds: string[];
        skillIds: string[];
        chatMode: "new" | "same";
        chatId: string | null;
        integrationGrants?: IntegrationGrant[];
        nextFireAt: Date | null;
      },
      tx?: DbTx,
    ): Effect.Effect<ScheduleRow>;
    /**
     * Records the chat a "same chat" schedule's first fire created. Only while
     * the schedule still wants one: an edit that picked another chat, or
     * switched to a new chat each time, wins over a fire already running.
     */
    adoptChat(scheduleId: string, chatId: string): Effect.Effect<void>;
    /** The owner's schedule that keeps running in this chat, if any. */
    findByChat(userId: string, chatId: string): Effect.Effect<ScheduleRow | null>;
    update(
      userId: string,
      scheduleId: string,
      changes: Partial<
        Pick<
          ScheduleRow,
          | "name"
          | "prompt"
          | "scheduleText"
          | "cron"
          | "timezone"
          | "endAt"
          | "modelId"
          | "agentId"
          | "searchEnabled"
          | "researchEnabled"
          | "collectionIds"
          | "skillIds"
          | "integrationGrants"
          | "chatMode"
          | "chatId"
          | "paused"
          | "nextFireAt"
        >
      >,
      tx?: DbTx,
    ): Effect.Effect<ScheduleRow | null>;
    remove(userId: string, scheduleId: string): Effect.Effect<void>;
    listRuns(
      userId: string,
      scheduleId: string,
      cursor: { firedAt: Date; id: string } | undefined,
      limit: number,
    ): Effect.Effect<{
      runs: ScheduleRunSummary[];
      nextCursor: { firedAt: Date; id: string } | null;
    }>;
    /** Manual fires reserve their attempt before detaching the work. */
    beginRun(scheduleId: string): Effect.Effect<RunRow>;
    /** Only an unbound attempt can be terminalized; a bound turn owns its answer. */
    finishRun(runId: string, status: "error" | "skipped", error: string): Effect.Effect<boolean>;
    /** Keep an active, unbound fire alive across slow pre-turn work. */
    renewRun(runId: string): Effect.Effect<void>;
    /** An unbound fire whose lease lapsed cannot be replayed safely. */
    expirePending(): Effect.Effect<RunRow[]>;
    /**
     * Atomically move due schedules to their next fire after now and return
     * the claimed rows. Claiming reschedules from now, so downtime costs one
     * catch-up fire, never a replayed backlog.
     */
    claimDue(
      limit: number,
      nextFor: (row: ScheduleRow) => Date | null,
    ): Effect.Effect<Array<ScheduleRow & { runId: string }>>;
  }
>()("chat/schedules/ScheduleRepo") {
  static readonly layer = Layer.effect(
    ScheduleRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      return ScheduleRepo.of({
        list: Effect.fn("ScheduleRepo.list")(function* (userId) {
          return yield* db
            .select()
            .from(schedules)
            .where(eq(schedules.userId, userId))
            .orderBy(schedules.name, schedules.id)
            .pipe(Effect.orDie);
        }),
        get: Effect.fn("ScheduleRepo.get")(function* (userId, scheduleId, tx) {
          const [row] = yield* (tx ?? db)
            .select()
            .from(schedules)
            .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
            .pipe(Effect.orDie);
          return row ?? null;
        }),
        insert: Effect.fn("ScheduleRepo.insert")(function* (input, tx) {
          const [row] = yield* (tx ?? db)
            .insert(schedules)
            .values({ id: uuidv7(), ...input })
            .returning()
            .pipe(Effect.orDie);
          return row!;
        }),
        findByChat: Effect.fn("ScheduleRepo.findByChat")(function* (userId, chatId) {
          const [row] = yield* db
            .select()
            .from(schedules)
            .where(and(eq(schedules.userId, userId), eq(schedules.chatId, chatId)))
            .orderBy(asc(schedules.createdAt))
            .limit(1)
            .pipe(Effect.orDie);
          return row ?? null;
        }),
        adoptChat: Effect.fn("ScheduleRepo.adoptChat")(function* (scheduleId, chatId) {
          yield* db
            .update(schedules)
            .set({ chatId, updatedAt: new Date() })
            .where(
              and(
                eq(schedules.id, scheduleId),
                eq(schedules.chatMode, "same"),
                isNull(schedules.chatId),
              ),
            )
            .pipe(Effect.orDie);
        }),
        update: Effect.fn("ScheduleRepo.update")(function* (userId, scheduleId, changes, tx) {
          const [row] = yield* (tx ?? db)
            .update(schedules)
            .set({ ...changes, updatedAt: new Date() })
            .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
            .returning()
            .pipe(Effect.orDie);
          return row ?? null;
        }),
        remove: Effect.fn("ScheduleRepo.remove")(function* (userId, scheduleId) {
          yield* db
            .delete(schedules)
            .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
            .pipe(Effect.orDie, Effect.asVoid);
        }),
        listRuns: Effect.fn("ScheduleRepo.listRuns")(function* (userId, scheduleId, cursor, limit) {
          const rows = yield* db
            .select({
              run: scheduleRuns,
              conversationTitle: conversations.title,
            })
            .from(scheduleRuns)
            .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
            .leftJoin(conversations, eq(conversations.id, scheduleRuns.conversationId))
            .where(
              and(
                eq(schedules.userId, userId),
                eq(scheduleRuns.scheduleId, scheduleId),
                cursor
                  ? or(
                      lt(scheduleRuns.firedAt, cursor.firedAt),
                      and(eq(scheduleRuns.firedAt, cursor.firedAt), lt(scheduleRuns.id, cursor.id)),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(scheduleRuns.firedAt), desc(scheduleRuns.id))
            .limit(limit + 1)
            .pipe(Effect.orDie);
          const page = rows.slice(0, limit);
          const last = rows.length > limit ? page.at(-1) : undefined;
          return {
            runs: page.map(({ run, conversationTitle }) => ({
              id: run.id,
              firedAt: run.firedAt.toISOString(),
              status: run.status,
              error: run.error,
              conversationId: run.conversationId,
              conversationTitle,
            })),
            nextCursor: last ? { firedAt: last.run.firedAt, id: last.run.id } : null,
          };
        }),
        beginRun: Effect.fn("ScheduleRepo.beginRun")(function* (scheduleId) {
          const [row] = yield* db
            .insert(scheduleRuns)
            .values({ id: uuidv7(), scheduleId, status: "pending" })
            .returning()
            .pipe(Effect.orDie);
          return row!;
        }),
        finishRun: Effect.fn("ScheduleRepo.finishRun")(function* (runId, status, error) {
          const rows = yield* db
            .update(scheduleRuns)
            .set({ status, error })
            .where(and(eq(scheduleRuns.id, runId), eq(scheduleRuns.status, "pending")))
            .returning({ id: scheduleRuns.id })
            .pipe(Effect.orDie);
          return rows.length > 0;
        }),
        renewRun: Effect.fn("ScheduleRepo.renewRun")(function* (runId) {
          yield* db
            .update(scheduleRuns)
            .set({ leaseUntil: sql`clock_timestamp() + interval '60 seconds'` })
            .where(and(eq(scheduleRuns.id, runId), eq(scheduleRuns.status, "pending")))
            .pipe(Effect.orDie, Effect.asVoid);
        }),
        expirePending: Effect.fn("ScheduleRepo.expirePending")(function* () {
          return yield* db
            .update(scheduleRuns)
            .set({
              status: "error",
              error: "the scheduled fire was interrupted before its turn started",
            })
            // A live fire renews its lease while waiting for the turn. A crashed
            // one cannot safely be replayed, even if its turn never became visible.
            .where(
              and(
                eq(scheduleRuns.status, "pending"),
                sql`${scheduleRuns.leaseUntil} <= clock_timestamp()`,
              ),
            )
            .returning()
            .pipe(Effect.orDie);
        }),
        claimDue: Effect.fn("ScheduleRepo.claimDue")(function* (limit, nextFor) {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                // Due-ness judged by the database clock, never a JS Date: the two
                // drift, and a scheduler that quietly sees nothing is the exact
                // failure this loop exists to prevent.
                const due = yield* tx
                  .select()
                  .from(schedules)
                  .where(
                    and(
                      isNotNull(schedules.nextFireAt),
                      lte(schedules.nextFireAt, sql`now()`),
                      eq(schedules.paused, false),
                    ),
                  )
                  .orderBy(schedules.nextFireAt)
                  .limit(limit)
                  .for("update", { skipLocked: true });
                const claimed: Array<ScheduleRow & { runId: string }> = [];
                for (const row of due) {
                  const next = nextFor(row);
                  const [updated] = yield* tx
                    .update(schedules)
                    .set({
                      nextFireAt: next,
                      lastFiredAt: sql`now()`,
                      updatedAt: sql`now()`,
                    })
                    .where(eq(schedules.id, row.id))
                    .returning();
                  if (updated) {
                    const runId = uuidv7();
                    yield* tx
                      .insert(scheduleRuns)
                      .values({ id: runId, scheduleId: row.id, status: "pending" });
                    claimed.push({ ...updated, runId });
                  }
                }
                return claimed;
              }),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
  static readonly batch = CLAIM_BATCH;
}
