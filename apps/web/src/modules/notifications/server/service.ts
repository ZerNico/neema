import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { notificationSettings } from "~/db/schema/index.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { Db } from "~/server/db.ts";
import type { AppNotification, NotificationPreferences } from "../schema.ts";
import { MailService } from "./mail.ts";
import { PushService } from "./push.ts";

/**
 * Tells a person something on the channels they chose. Each channel is best
 * effort and logged: a notification that cannot be delivered never fails the
 * work that produced it.
 */
export class NotificationService extends Context.Service<
  NotificationService,
  {
    deliver(userId: string, notification: AppNotification): Effect.Effect<void>;
    preferences(userId: string): Effect.Effect<NotificationPreferences>;
    setPreferences(
      userId: string,
      changes: { push?: boolean; email?: boolean },
    ): Effect.Effect<void>;
  }
>()("chat/notifications/NotificationService") {
  static readonly layer = Layer.effect(
    NotificationService,
    Effect.gen(function* () {
      const db = yield* Db;
      const bus = yield* SyncBus;
      const push = yield* PushService;
      const mail = yield* MailService;

      const chosen = (userId: string) =>
        Effect.map(
          db
            .select({ push: notificationSettings.push, email: notificationSettings.email })
            .from(notificationSettings)
            .where(eq(notificationSettings.userId, userId))
            .pipe(Effect.orDie),
          ([row]) => row ?? { push: true, email: false },
        );

      return NotificationService.of({
        deliver: Effect.fn("NotificationService.deliver")(function* (userId, notification) {
          const channels = yield* chosen(userId);
          yield* Effect.all(
            [
              channels.push
                ? Effect.all(
                    [
                      // Open tabs and the desktop app show it themselves.
                      bus
                        .publish(userId, { type: "notification", notification })
                        .pipe(
                          Effect.catchCause((cause) =>
                            Effect.logWarning("notification could not reach open sessions", cause),
                          ),
                        ),
                      // Browsers that are closed, and phones.
                      push.send(userId, notification),
                    ],
                    { discard: true },
                  )
                : Effect.void,
              channels.email ? mail.send(userId, notification) : Effect.void,
            ],
            { concurrency: "unbounded", discard: true },
          );
        }),
        preferences: Effect.fn("NotificationService.preferences")(function* (userId) {
          return { ...(yield* chosen(userId)), emailAvailable: yield* mail.available };
        }),
        setPreferences: Effect.fn("NotificationService.setPreferences")(
          function* (userId, changes) {
            const current = yield* chosen(userId);
            yield* db
              .insert(notificationSettings)
              .values({ userId, ...current, ...changes })
              .onConflictDoUpdate({
                target: notificationSettings.userId,
                set: { ...changes, updatedAt: sql`now()` },
              })
              .pipe(Effect.orDie);
          },
        ),
      });
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(PushService.layer, MailService.layer)));
}
