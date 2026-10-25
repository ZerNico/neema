import { Context, Duration, Effect, Exit, Layer, Schedule as EffectSchedule } from "effect";
import { eq } from "drizzle-orm";
import { schedules } from "~/db/schema/index.ts";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { accountEligible } from "~/modules/auth/server/account-eligibility.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import { FeaturePolicy } from "~/modules/groups/server/policy.ts";
import { ScheduleNotAvailable, ScheduleRejected, type ScheduleRunSummary } from "../schema.ts";
import { isValidTimezone, previewFires, validateCron } from "./cron.ts";
import { ScheduleFire, type FireOutcome } from "./fire.ts";
import { ScheduleRepo, toSummary, type ScheduleRow } from "./repo.ts";
import { ScheduleSettlement } from "./settle.ts";
import { checkScheduleResources, firstFireAt, validateScheduleSettings } from "./validate.ts";

const TICK_INTERVAL = Duration.seconds(30);

export class ScheduleService extends Context.Service<
  ScheduleService,
  {
    list(userId: string): Effect.Effect<ReturnType<typeof toSummary>[]>;
    get(userId: string, scheduleId: string): Effect.Effect<ScheduleRow, ScheduleNotAvailable>;
    listRuns(
      userId: string,
      scheduleId: string,
      cursor: { firedAt: Date; id: string } | undefined,
      limit?: number,
    ): Effect.Effect<
      { runs: ScheduleRunSummary[]; nextCursor: { firedAt: Date; id: string } | null },
      ScheduleNotAvailable
    >;
    create(userId: string, input: unknown): Effect.Effect<ScheduleRow, ScheduleRejected>;
    update(
      userId: string,
      scheduleId: string,
      input: unknown,
    ): Effect.Effect<ScheduleRow, ScheduleNotAvailable | ScheduleRejected>;
    pause(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    resume(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    remove(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    preview(input: {
      cron: string;
      timezone: string;
      endAt?: string | null | undefined;
    }): Effect.Effect<string[], ScheduleRejected>;
    /** "Run now": fires without touching the cadence. */
    runNow(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    /**
     * One claim-and-fire pass, driven by the tick loop and by tests. The claim
     * itself reschedules from now, so a schedule that missed fires while the
     * server was down fires exactly once and resumes its cadence.
     */
    readonly tick: Effect.Effect<void>;
  }
>()("chat/schedules/ScheduleService") {
  static readonly layer = Layer.effect(
    ScheduleService,
    Effect.gen(function* () {
      const db = yield* Db;
      const policy = yield* FeaturePolicy;
      const repo = yield* ScheduleRepo;
      const providers = yield* ProviderRepo;
      const agents = yield* AgentRepo;
      const bus = yield* SyncBus;
      const settlement = yield* ScheduleSettlement;
      const changed = (userId: string, scheduleId: string) =>
        bus
          .publish(userId, { type: "schedule.changed", scheduleId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule invalidation failed")));
      const runChanged = (userId: string, scheduleId: string, runId: string) =>
        bus
          .publish(userId, { type: "schedule.run.changed", scheduleId, runId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule run invalidation failed")));

      const validate = (userId: string, raw: unknown) =>
        validateScheduleSettings({ providers, agents, policy }, userId, raw);

      const get = Effect.fn("ScheduleService.get")(function* (userId, scheduleId) {
        if (!(yield* policy.can(userId, "schedules")))
          return yield* new ScheduleNotAvailable({ scheduleId });
        const row = yield* repo.get(userId, scheduleId);
        if (!row) return yield* new ScheduleNotAvailable({ scheduleId });
        return row;
      });

      const fire = (row: ScheduleRow, runId: string) =>
        Effect.gen(function* () {
          yield* Effect.forkScoped(
            repo.renewRun(runId).pipe(Effect.delay(Duration.seconds(10)), Effect.forever),
          );
          if (!(yield* accountEligible(row.userId).pipe(Effect.provideService(Db, db)))) {
            yield* repo.finishRun(
              runId,
              "skipped",
              "the account is not permitted to run schedules",
            );
            yield* settlement.settle;
            yield* runChanged(row.userId, row.id, runId);
            return;
          }
          if (!(yield* policy.can(row.userId, "schedules"))) {
            yield* repo.finishRun(runId, "skipped", "schedule access is not permitted");
            yield* settlement.settle;
            yield* runChanged(row.userId, row.id, runId);
            return;
          }
          const outcome = yield* fireSchedule(row, runId).pipe(
            Effect.catch((error: unknown) =>
              Effect.logError("scheduled fire failed", { scheduleId: row.id, error }).pipe(
                Effect.as({
                  conversationId: null,
                  status: "error",
                  reason: "the scheduled message could not be sent",
                } satisfies FireOutcome),
              ),
            ),
          );
          if (outcome.conversationId === null) {
            yield* repo.finishRun(runId, outcome.status, outcome.reason);
            yield* settlement.settle;
          }
          yield* runChanged(row.userId, row.id, runId);
        }).pipe(
          Effect.scoped,
          // Defects and interruption bypass typed catches. A bound turn stays
          // started; its generation lease is responsible for its answer.
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? // Logged with its cause: a defect here left nothing but the run's
                // error to go on, which read as an interruption.
                Effect.logError("scheduled fire did not start", exit.cause).pipe(
                  Effect.annotateLogs({ scheduleId: row.id, runId }),
                  Effect.andThen(
                    repo.finishRun(
                      runId,
                      "error",
                      "the scheduled fire was interrupted before its turn started",
                    ),
                  ),
                  Effect.flatMap((settled) =>
                    settled ? runChanged(row.userId, row.id, runId) : Effect.void,
                  ),
                )
              : Effect.void,
          ),
        );

      // Defined in ./fire.ts to keep the chat coupling in one place.
      const fireSchedule = yield* ScheduleFire;

      const tick: Effect.Effect<void> = Effect.suspend(() =>
        Effect.gen(function* () {
          const expired = yield* repo.expirePending();
          for (const run of expired) {
            const row = yield* db
              .select({ userId: schedules.userId })
              .from(schedules)
              .where(eq(schedules.id, run.scheduleId))
              .pipe(Effect.orDie);
            if (row[0]) yield* runChanged(row[0].userId, run.scheduleId, run.id);
          }
          // Answers the reaper ended, and turns a restart cut off, have no
          // turn left to settle them.
          yield* settlement.settle;
          const claimed = yield* repo.claimDue(ScheduleRepo.batch, (row, claimedAt) =>
            firstFireAt({ cron: row.cron, timezone: row.timezone, endAt: row.endAt }, claimedAt),
          );
          for (const { runId, ...row } of claimed) {
            // The pending row committed with the claim, even if this process
            // exits before the detached fire gets a chance to start.
            yield* Effect.forkDetach(fire(row, runId));
          }
        }),
      );

      yield* tick.pipe(
        Effect.catchCause((cause) => Effect.logError("schedule tick failed", cause)),
        Effect.repeat(EffectSchedule.spaced(TICK_INTERVAL)),
        Effect.forkScoped,
      );

      return ScheduleService.of({
        list: Effect.fn("ScheduleService.list")(function* (userId) {
          if (!(yield* policy.can(userId, "schedules"))) return [];
          return (yield* repo.list(userId)).map(toSummary);
        }),
        get,
        listRuns: Effect.fn("ScheduleService.listRuns")(function* (
          userId,
          scheduleId,
          cursor,
          limit = 50,
        ) {
          yield* get(userId, scheduleId);
          return yield* repo.listRuns(userId, scheduleId, cursor, limit);
        }),
        create: Effect.fn("ScheduleService.create")(function* (userId, input) {
          if (!(yield* policy.can(userId, "schedules")))
            return yield* new ScheduleRejected({ reason: "schedule creation is unavailable" });
          const settings = yield* validate(userId, input);
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new ScheduleRejected({
                    reason: "schedule creation is unavailable",
                  });
                yield* checkScheduleResources(tx, userId, settings);
                return yield* repo.insert(
                  { userId, ...settings, nextFireAt: firstFireAt(settings) },
                  tx,
                );
              }),
            )
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
              Effect.catchTag("SqlError", Effect.die),
            );
          yield* changed(userId, row.id);
          return row;
        }),
        update: Effect.fn("ScheduleService.update")(function* (userId, scheduleId, input) {
          const settings = yield* validate(userId, input);
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                if (!(yield* policy.can(userId, "schedules", tx)))
                  return yield* new ScheduleNotAvailable({ scheduleId });
                yield* checkScheduleResources(tx, userId, settings);
                const updated = yield* repo.update(
                  userId,
                  scheduleId,
                  { ...settings, nextFireAt: firstFireAt(settings) },
                  tx,
                );
                if (!updated) return yield* new ScheduleNotAvailable({ scheduleId });
                return updated;
              }),
            )
            .pipe(
              Effect.catchTag("EffectDrizzleQueryError", Effect.die),
              Effect.catchTag("SqlError", Effect.die),
            );
          yield* changed(userId, row.id);
          return row;
        }),
        pause: Effect.fn("ScheduleService.pause")(function* (userId, scheduleId) {
          yield* get(userId, scheduleId);
          if (!(yield* repo.setPaused(userId, scheduleId, true, null)))
            return yield* new ScheduleNotAvailable({ scheduleId });
          yield* changed(userId, scheduleId);
        }),
        resume: Effect.fn("ScheduleService.resume")(function* (userId, scheduleId) {
          const current = yield* get(userId, scheduleId);
          if (!(yield* repo.setPaused(userId, scheduleId, false, firstFireAt(current))))
            return yield* new ScheduleNotAvailable({ scheduleId });
          yield* changed(userId, scheduleId);
        }),
        remove: Effect.fn("ScheduleService.remove")(function* (userId, scheduleId) {
          yield* get(userId, scheduleId);
          yield* repo.remove(userId, scheduleId);
          yield* changed(userId, scheduleId);
        }),
        preview: Effect.fn("ScheduleService.preview")(function* (input) {
          const issue = validateCron(input.cron, input.timezone);
          if (issue) return yield* new ScheduleRejected({ reason: `invalid schedule: ${issue}` });
          if (!isValidTimezone(input.timezone))
            return yield* new ScheduleRejected({ reason: "unknown timezone" });
          const endAt = input.endAt ? new Date(input.endAt) : null;
          return previewFires(input.cron, input.timezone, 5, new Date(), endAt).map((at) =>
            at.toISOString(),
          );
        }),
        tick,
        runNow: Effect.fn("ScheduleService.runNow")(function* (userId, scheduleId) {
          const row = yield* get(userId, scheduleId);
          const run = yield* repo.beginRun(row.id);
          yield* Effect.forkDetach(fire(row, run.id));
        }),
      });
    }),
  ).pipe(Layer.provide(ScheduleRepo.layer));
}
