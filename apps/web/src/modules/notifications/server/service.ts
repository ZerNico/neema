import { Context, Effect, Layer } from "effect";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import type { AppNotification } from "../schema.ts";

/**
 * Tells a person something on every channel they have. Each channel is best
 * effort and logged: a notification that cannot be delivered never fails the
 * work that produced it.
 */
export class NotificationService extends Context.Service<
  NotificationService,
  { deliver(userId: string, notification: AppNotification): Effect.Effect<void> }
>()("chat/notifications/NotificationService") {
  static readonly layer = Layer.effect(
    NotificationService,
    Effect.gen(function* () {
      const bus = yield* SyncBus;
      return NotificationService.of({
        deliver: Effect.fn("NotificationService.deliver")(function* (userId, notification) {
          // Open tabs and the desktop app show it themselves.
          yield* bus
            .publish(userId, { type: "notification", notification })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("notification could not reach open sessions", cause),
              ),
            );
        }),
      });
    }),
  );
}
