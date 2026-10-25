import { leaseFor } from "~/server/sql.ts";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { uuidv7 } from "uuidv7";
import {
  conversations,
  messages,
  scheduleIntegrationGrants,
  scheduleRuns,
  schedules,
} from "~/db/schema/index.ts";
import { Db, type DbTx } from "~/server/db.ts";
import type { ScheduleRunSummary, ScheduleSummary } from "../schema.ts";
import type { IntegrationGrant, ScheduleGrant } from "~/modules/integrations/grant.ts";
import { answered, type SettledRun } from "../settled-run.ts";

/** How long a scheduled run is held between its renewals. */
const RUN_LEASE_SECONDS = 60;

type ScheduleColumns = typeof schedules.$inferSelect;
/** A schedule with its integration grants, ordered so a fire offers them alike each time. */
export type ScheduleRow = ScheduleColumns & { integrationGrants: ScheduleGrant[] };
type RunRow = typeof scheduleRuns.$inferSelect;

export const toSummary = (row: ScheduleColumns): ScheduleSummary => ({
  id: row.id,
  name: row.name,
  scheduleText: row.scheduleText,
  cron: row.cron,
  timezone: row.timezone,
  paused: row.paused,
  nextFireAt: row.nextFireAt?.toISOString() ?? null,
  lastFiredAt: row.lastFiredAt?.toISOString() ?? null,
});

/** Puts a schedule's grants in place of what it had. */
const replaceGrants = (tx: DbTx, scheduleId: string, grants: IntegrationGrant[]) =>
  Effect.gen(function* () {
    yield* tx
      .delete(scheduleIntegrationGrants)
      .where(eq(scheduleIntegrationGrants.scheduleId, scheduleId))
      .pipe(Effect.orDie);
    if (grants.length)
      yield* tx
        .insert(scheduleIntegrationGrants)
        .values(
          grants.map((grant) => ({
            scheduleId,
            connectionId: grant.connectionId,
            integrationId: grant.integrationId,
            access: grant.access,
            allowances: grant.allowances ?? null,
          })),
        )
        .pipe(Effect.orDie);
  });

const CLAIM_BATCH = 25;
const SETTLE_BATCH = 50;

/** Every setting a schedule row holds, as an editor writes them. */
type ScheduleSettingsWrite = Pick<
  ScheduleColumns,
  | "name"
  | "prompt"
  | "scheduleText"
  | "cron"
  | "timezone"
  | "endAt"
  | "modelId"
  | "agentId"
  | "imageModelId"
  | "searchEnabled"
  | "researchEnabled"
  | "collectionIds"
  | "skillIds"
  | "notify"
  | "chatMode"
  | "chatId"
  | "nextFireAt"
> & { integrationGrants: IntegrationGrant[] };

export class ScheduleRepo extends Context.Service<
  ScheduleRepo,
  {
    list(userId: string): Effect.Effect<ScheduleColumns[]>;
    get(userId: string, scheduleId: string, tx?: DbTx): Effect.Effect<ScheduleRow | null>;
    insert(
      input: ScheduleSettingsWrite & { userId: string },
      tx?: DbTx,
    ): Effect.Effect<ScheduleRow>;
    /**
     * Records the chat a "same chat" schedule's fire created, in place of
     * `replacing`, the deleted chat that fire found (null for a first fire).
     * Only while the schedule still holds what the fire saw, or nothing, the
     * purge having cleared it: an edit that picked another chat, or switched
     * to a new chat each time, wins over a fire already running.
     */
    adoptChat(scheduleId: string, chatId: string, replacing: string | null): Effect.Effect<void>;
    /** The owner's schedule that keeps running in this chat, if any. */
    findByChat(userId: string, chatId: string): Effect.Effect<ScheduleRow | null>;
    /**
     * Replaces every setting and grant and moves the config revision. With
     * `expectedRevision`, only over that revision; null when the schedule is
     * gone or has moved on.
     */
    update(
      userId: string,
      scheduleId: string,
      settings: ScheduleSettingsWrite,
      tx: DbTx,
      expectedRevision?: number,
    ): Effect.Effect<ScheduleRow | null>;
    setPaused(
      userId: string,
      scheduleId: string,
      paused: boolean,
      nextFireAt: Date | null,
    ): Effect.Effect<boolean>;
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
      nextFor: (row: ScheduleColumns, claimedAt: Date) => Date | null,
    ): Effect.Effect<Array<ScheduleRow & { runId: string }>>;
    /**
     * Claims the runs that have ended and marks each settled, once: a run that
     * never started, or whose answer is no longer streaming or is no longer the
     * fire's attempt. Marks their chats unread in the same transaction.
     */
    settleRuns(): Effect.Effect<SettledRun[]>;
  }
>()("chat/schedules/ScheduleRepo") {
  static readonly layer = Layer.effect(
    ScheduleRepo,
    Effect.gen(function* () {
      const db = yield* Db;
      const inTx = <A>(tx: DbTx | undefined, work: (tx: DbTx) => Effect.Effect<A>) =>
        tx ? work(tx) : db.transaction(work).pipe(Effect.orDie);
      /** Each schedule with its grants, read on the same connection as the rows. */
      const withGrants = (
        reader: DbTx | typeof db,
        rows: ReadonlyArray<ScheduleColumns>,
      ): Effect.Effect<ScheduleRow[]> =>
        Effect.gen(function* () {
          if (rows.length === 0) return [];
          const grants = yield* reader
            .select()
            .from(scheduleIntegrationGrants)
            .where(
              inArray(
                scheduleIntegrationGrants.scheduleId,
                rows.map((row) => row.id),
              ),
            )
            .orderBy(
              asc(scheduleIntegrationGrants.integrationId),
              sql`${scheduleIntegrationGrants.connectionId} asc nulls last`,
            )
            .pipe(Effect.orDie);
          return rows.map((row) => ({
            ...row,
            integrationGrants: grants
              .filter((grant) => grant.scheduleId === row.id)
              .map(({ connectionId, integrationId, access, allowances }) => ({
                connectionId,
                integrationId,
                access,
                ...(allowances ? { allowances } : {}),
              })),
          }));
        });
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
          const reader = tx ?? db;
          const rows = yield* reader
            .select()
            .from(schedules)
            .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
            .pipe(Effect.orDie);
          const [row] = yield* withGrants(reader, rows);
          return row ?? null;
        }),
        insert: Effect.fn("ScheduleRepo.insert")(function* ({ integrationGrants, ...input }, tx) {
          return yield* inTx(tx, (write) =>
            Effect.gen(function* () {
              const [row] = yield* write
                .insert(schedules)
                .values({ id: uuidv7(), ...input })
                .returning()
                .pipe(Effect.orDie);
              yield* replaceGrants(write, row!.id, integrationGrants);
              const [stored] = yield* withGrants(write, [row!]);
              return stored!;
            }),
          );
        }),
        findByChat: Effect.fn("ScheduleRepo.findByChat")(function* (userId, chatId) {
          const rows = yield* db
            .select()
            .from(schedules)
            .where(and(eq(schedules.userId, userId), eq(schedules.chatId, chatId)))
            .orderBy(asc(schedules.createdAt))
            .limit(1)
            .pipe(Effect.orDie);
          const [row] = yield* withGrants(db, rows);
          return row ?? null;
        }),
        adoptChat: Effect.fn("ScheduleRepo.adoptChat")(function* (scheduleId, chatId, replacing) {
          yield* db
            .update(schedules)
            .set({
              chatId,
              configRevision: sql`${schedules.configRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schedules.id, scheduleId),
                eq(schedules.chatMode, "same"),
                replacing === null
                  ? isNull(schedules.chatId)
                  : or(isNull(schedules.chatId), eq(schedules.chatId, replacing)),
              ),
            )
            .pipe(Effect.orDie);
        }),
        update: Effect.fn("ScheduleRepo.update")(function* (
          userId,
          scheduleId,
          { integrationGrants, nextFireAt, ...settings },
          tx,
          expectedRevision,
        ) {
          const [row] = yield* tx
            .update(schedules)
            .set({
              ...settings,
              // A paused schedule has no next fire, whichever edit sets one.
              nextFireAt: nextFireAt
                ? sql`case when ${schedules.paused} then null else ${nextFireAt.toISOString()}::timestamptz end`
                : null,
              configRevision: sql`${schedules.configRevision} + 1`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(schedules.id, scheduleId),
                eq(schedules.userId, userId),
                expectedRevision === undefined
                  ? undefined
                  : eq(schedules.configRevision, expectedRevision),
              ),
            )
            .returning()
            .pipe(Effect.orDie);
          if (!row) return null;
          yield* replaceGrants(tx, row.id, integrationGrants);
          const [stored] = yield* withGrants(tx, [row]);
          return stored ?? null;
        }),
        setPaused: Effect.fn("ScheduleRepo.setPaused")(function* (
          userId,
          scheduleId,
          paused,
          nextFireAt,
        ) {
          const rows = yield* db
            .update(schedules)
            .set({ paused, nextFireAt, updatedAt: new Date() })
            .where(and(eq(schedules.id, scheduleId), eq(schedules.userId, userId)))
            .returning({ id: schedules.id })
            .pipe(Effect.orDie);
          return rows.length > 0;
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
              // Through the join, so a chat deleted and waiting out its grace
              // period reads as gone, as it will once purged.
              conversationId: conversations.id,
              conversationTitle: conversations.title,
            })
            .from(scheduleRuns)
            .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
            .leftJoin(
              conversations,
              and(
                eq(conversations.id, scheduleRuns.conversationId),
                isNull(conversations.deletedAt),
              ),
            )
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
            runs: page.map(({ run, conversationId, conversationTitle }) => ({
              id: run.id,
              firedAt: run.firedAt.toISOString(),
              status: run.status,
              error: run.error,
              conversationId,
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
            .set({ leaseUntil: leaseFor(RUN_LEASE_SECONDS) })
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
                  .select({ schedule: schedules, claimedAt: sql<string>`now()::text` })
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
                const claimed: Array<ScheduleColumns & { runId: string }> = [];
                for (const { schedule: row, claimedAt } of due) {
                  const next = nextFor(row, new Date(claimedAt));
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
                const loaded = yield* withGrants(tx, claimed);
                return loaded.map((row, index) => ({ ...row, runId: claimed[index]!.runId }));
              }),
            )
            .pipe(Effect.orDie);
        }),
        settleRuns: Effect.fn("ScheduleRepo.settleRuns")(function* () {
          return yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                const rows = yield* tx
                  .select({
                    run: scheduleRuns,
                    scheduleName: schedules.name,
                    userId: schedules.userId,
                    notify: schedules.notify,
                    messageStatus: messages.status,
                    messageContent: messages.content,
                    messageGenerationId: messages.generationId,
                  })
                  .from(scheduleRuns)
                  .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
                  .leftJoin(messages, eq(messages.id, scheduleRuns.messageId))
                  .where(
                    and(
                      isNull(scheduleRuns.settledAt),
                      or(
                        inArray(scheduleRuns.status, ["error", "skipped"]),
                        and(
                          eq(scheduleRuns.status, "started"),
                          or(
                            isNull(messages.id),
                            sql`${messages.status} <> 'streaming'`,
                            sql`${messages.generationId} is distinct from ${scheduleRuns.generationId}`,
                          ),
                        ),
                      ),
                    ),
                  )
                  .orderBy(scheduleRuns.firedAt)
                  .limit(SETTLE_BATCH)
                  // Two settlers (the turn's own and the tick) never claim one run twice.
                  .for("update", { of: scheduleRuns, skipLocked: true });
                if (rows.length === 0) return [];
                yield* tx
                  .update(scheduleRuns)
                  .set({ settledAt: sql`now()` })
                  .where(
                    inArray(
                      scheduleRuns.id,
                      rows.map((row) => row.run.id),
                    ),
                  );
                const settled = rows.map((row): SettledRun => ({
                  runId: row.run.id,
                  scheduleId: row.run.scheduleId,
                  scheduleName: row.scheduleName,
                  userId: row.userId,
                  notify: row.notify,
                  status: row.run.status,
                  error: row.run.error,
                  conversationId: row.run.conversationId,
                  answer: row.messageStatus
                    ? {
                        status: row.messageStatus,
                        content: row.messageContent ?? "",
                        current: row.messageGenerationId === row.run.generationId,
                      }
                    : null,
                  notifyMessage: row.run.notifyMessage,
                }));
                const unread = settled.filter(answered).map((run) => run.conversationId!);
                if (unread.length > 0)
                  yield* tx
                    .update(conversations)
                    .set({ unread: true })
                    .where(inArray(conversations.id, unread));
                return settled;
              }),
            )
            .pipe(Effect.orDie);
        }),
      });
    }),
  );
  static readonly batch = CLAIM_BATCH;
}
