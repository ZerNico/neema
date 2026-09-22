import { Context, Duration, Effect, Layer, Schedule as EffectSchedule } from "effect";
import { AgentRepo } from "~/modules/agents/server/repo.ts";
import { ProviderRepo } from "~/modules/providers/server/repo.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import {
  ScheduleNotAvailable,
  ScheduleRejected,
  type ScheduleRunSummary,
} from "../schema.ts";
import { isValidTimezone, previewFires, validateCron } from "./cron.ts";
import { ScheduleFire, type FireOutcome } from "./fire.ts";
import { ScheduleRepo, toSummary, type ScheduleRow } from "./repo.ts";
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
    create(
      userId: string,
      input: unknown,
    ): Effect.Effect<ScheduleRow, ScheduleRejected>;
    update(
      userId: string,
      scheduleId: string,
      input: unknown,
    ): Effect.Effect<ScheduleRow, ScheduleNotAvailable | ScheduleRejected>;
    pause(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    resume(userId: string, scheduleId: string): Effect.Effect<void, ScheduleNotAvailable>;
    remove(userId: string, scheduleId: string): Effect.Effect<void>;
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
      const repo = yield* ScheduleRepo;
      const providers = yield* ProviderRepo;
      const agents = yield* AgentRepo;
      const bus = yield* SyncBus;
      const changed = (userId: string, scheduleId: string) =>
        bus
          .publish(userId, { type: "schedule.changed", scheduleId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule invalidation failed")));
      const runChanged = (userId: string, scheduleId: string, runId: string) =>
        bus
          .publish(userId, { type: "schedule.run.changed", scheduleId, runId })
          .pipe(Effect.catchCause(() => Effect.logWarning("schedule run invalidation failed")));

      const validate = (userId: string, raw: unknown) =>
        validateScheduleSettings({ providers, agents }, userId, raw);

      const get = Effect.fn("ScheduleService.get")(function* (userId, scheduleId) {
        const row = yield* repo.get(userId, scheduleId);
        if (!row) return yield* new ScheduleNotAvailable({ scheduleId });
        return row;
      });

      const fire = Effect.fn("ScheduleService.fire")(function* (row: ScheduleRow) {
        const outcome = yield* fireSchedule(row).pipe(
          Effect.catch((error: unknown) =>
            Effect.logError("scheduled fire failed", { scheduleId: row.id, error }).pipe(
              Effect.as({
                conversationId: null,
                error: "the scheduled message could not be sent",
              } satisfies FireOutcome),
            ),
          ),
        );
        const run = yield* repo.recordRun({
          scheduleId: row.id,
          conversationId: outcome.conversationId,
          status: outcome.conversationId ? "started" : "error",
          error: outcome.error,
        });
        yield* runChanged(row.userId, row.id, run.id);
      });

      // Defined in ./fire.ts to keep the chat coupling in one place.
      const fireSchedule = yield* ScheduleFire;

      const tick: Effect.Effect<void> = Effect.suspend(() =>
        Effect.gen(function* () {
          const claimed = yield* repo.claimDue(ScheduleRepo.batch, (row) =>
            firstFireAt({ cron: row.cron, timezone: row.timezone, endAt: row.endAt }),
          );
          for (const row of claimed) {
            // Detached so one slow fire cannot hold the tick; the claim already
            // rescheduled, and the run row is the record of the attempt.
            yield* Effect.forkDetach(fire(row));
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
          return (yield* repo.list(userId)).map(toSummary);
        }),
        get,
        listRuns: Effect.fn("ScheduleService.listRuns")(function* (userId, scheduleId, cursor, limit = 50) {
          yield* get(userId, scheduleId);
          return yield* repo.listRuns(userId, scheduleId, cursor, limit);
        }),
        create: Effect.fn("ScheduleService.create")(function* (userId, input) {
          const settings = yield* validate(userId, input);
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* checkScheduleResources(tx, userId, settings);
                return yield* repo.insert({ userId, ...settings, nextFireAt: firstFireAt(settings) });
              }),
            )
            .pipe(Effect.orDie);
          yield* changed(userId, row.id);
          return row;
        }),
        update: Effect.fn("ScheduleService.update")(function* (userId, scheduleId, input) {
          const settings = yield* validate(userId, input);
          const row = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* get(userId, scheduleId);
                yield* checkScheduleResources(tx, userId, settings);
                return yield* repo.update(userId, scheduleId, {
                  ...settings,
                  nextFireAt: firstFireAt(settings),
                });
              }),
            )
            .pipe(Effect.orDie);
          if (!row) return yield* new ScheduleNotAvailable({ scheduleId });
          yield* changed(userId, row.id);
          return row;
        }),
        pause: Effect.fn("ScheduleService.pause")(function* (userId, scheduleId) {
          const row = yield* repo.update(userId, scheduleId, { paused: true, nextFireAt: null });
          if (!row) return yield* new ScheduleNotAvailable({ scheduleId });
          yield* changed(userId, scheduleId);
        }),
        resume: Effect.fn("ScheduleService.resume")(function* (userId, scheduleId) {
          const current = yield* get(userId, scheduleId);
          const row = yield* repo.update(userId, scheduleId, {
            paused: false,
            nextFireAt: firstFireAt(current),
          });
          if (!row) return yield* new ScheduleNotAvailable({ scheduleId });
          yield* changed(userId, scheduleId);
        }),
        remove: Effect.fn("ScheduleService.remove")(function* (userId, scheduleId) {
          yield* repo.remove(userId, scheduleId);
          yield* changed(userId, scheduleId);
        }),
        preview: Effect.fn("ScheduleService.preview")(function* (input) {
          const issue = validateCron(input.cron, input.timezone);
          if (issue) return yield* new ScheduleRejected({ reason: `invalid schedule: ${issue}` });
          if (!isValidTimezone(input.timezone))
            return yield* new ScheduleRejected({ reason: "unknown timezone" });
          const endAt = input.endAt ? new Date(input.endAt) : null;
          return previewFires(input.cron, input.timezone, 5, new Date(), endAt).map((fire) =>
            fire.toISOString(),
          );
        }),
        tick,
        runNow: Effect.fn("ScheduleService.runNow")(function* (userId, scheduleId) {
          const row = yield* get(userId, scheduleId);
          yield* Effect.forkDetach(fire(row));
        }),
      });
    }),
  ).pipe(Layer.provide(ScheduleRepo.layer));
}
