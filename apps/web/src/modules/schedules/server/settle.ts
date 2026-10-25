import { Context, Effect, Layer } from "effect";
import { NotificationService } from "~/modules/notifications/server/service.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { LanguageRepo } from "~/modules/language/server/repo.ts";
import { answered, runEmail, runNotification } from "../settled-run.ts";
import { ScheduleRepo } from "./repo.ts";

/**
 * Ends runs that are over and tells their owners. The turn calls it the
 * moment its answer settles; the scheduler's tick calls it too, for answers
 * the reaper ended and turns a restart cut off. The claim makes either
 * caller's pass the only one for a run.
 */
export class ScheduleSettlement extends Context.Service<
  ScheduleSettlement,
  { readonly settle: Effect.Effect<void> }
>()("chat/schedules/ScheduleSettlement") {
  static readonly layer = Layer.effect(
    ScheduleSettlement,
    Effect.gen(function* () {
      const repo = yield* ScheduleRepo;
      const bus = yield* SyncBus;
      const notifications = yield* NotificationService;
      const languages = yield* LanguageRepo;
      const settle = Effect.gen(function* () {
        const runs = yield* repo.settleRuns();
        yield* Effect.forEach(
          runs,
          (run) =>
            Effect.gen(function* () {
              if (answered(run))
                yield* bus.publish(run.userId, {
                  type: "conversation.updated",
                  conversationId: run.conversationId!,
                });
              const notification = runNotification(run, yield* languages.localeOf(run.userId));
              if (notification)
                yield* notifications.deliver(run.userId, notification, runEmail(run));
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("settled run could not be announced", {
                  runId: run.runId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
      }).pipe(Effect.withSpan("ScheduleSettlement.settle"));
      return ScheduleSettlement.of({ settle });
    }),
  ).pipe(Layer.provide([ScheduleRepo.layer, LanguageRepo.layer]));
}
