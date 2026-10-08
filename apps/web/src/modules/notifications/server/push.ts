import { and, eq, notInArray, sql } from "drizzle-orm";
import { Context, Effect, Layer, Redacted, Schema } from "effect";
import { uuidv7 } from "uuidv7";
import { pushKeys, pushSubscriptions } from "~/db/schema/index.ts";
import { KeyCipher } from "~/modules/providers/server/crypto.ts";
import { fetchPinned, resolvePublicHttpUrl } from "~/modules/tools/server/url-safety.ts";
import { Db } from "~/server/db.ts";
import { publicUrl } from "~/server/public-url.ts";
import type { AppNotification } from "../schema.ts";
import {
  base64url,
  encryptPushPayload,
  fromBase64url,
  generateVapidKeys,
  vapidAuthorization,
  type VapidKeys,
} from "./web-push.ts";

const KEYS_ID = "instance";
/** More than anyone has browsers; the oldest goes first. */
const MAX_SUBSCRIPTIONS = 20;

export class PushRejected extends Schema.TaggedError<PushRejected>()("PushRejected", {
  reason: Schema.String,
}) {}

/**
 * Notifications for browsers that are closed. A subscription's endpoint is a
 * URL the browser chose, so it is checked like any address the server fetches,
 * when it is saved and again for every send.
 */
export class PushService extends Context.Service<
  PushService,
  {
    /** The key browsers subscribe with, made the first time anyone asks. */
    readonly publicKey: Effect.Effect<string>;
    /** Ties this browser to the sign-in, which ending stops it. */
    subscribe(
      owner: { userId: string; sessionId: string },
      subscription: { endpoint: string; p256dh: string; auth: string },
    ): Effect.Effect<void, PushRejected>;
    send(userId: string, notification: AppNotification): Effect.Effect<void>;
  }
>()("chat/notifications/PushService") {
  static readonly layer = Layer.effect(
    PushService,
    Effect.gen(function* () {
      const db = yield* Db;
      const cipher = yield* KeyCipher;

      const readKeys = Effect.gen(function* () {
        const [row] = yield* db.select().from(pushKeys).where(eq(pushKeys.id, KEYS_ID));
        return row ?? null;
      }).pipe(Effect.orDie);

      // Two first requests may race; the insert that loses keeps the winner's.
      const keys: Effect.Effect<VapidKeys> = Effect.gen(function* () {
        let row = yield* readKeys;
        if (!row) {
          const fresh = generateVapidKeys();
          yield* db
            .insert(pushKeys)
            .values({
              id: KEYS_ID,
              publicKey: base64url(fresh.publicKey),
              privateKeyCiphertext: yield* cipher.encrypt(base64url(fresh.privateKey)),
            })
            .onConflictDoNothing()
            .pipe(Effect.orDie);
          row = (yield* readKeys)!;
        }
        return {
          publicKey: fromBase64url(row.publicKey),
          privateKey: fromBase64url(
            Redacted.value(yield* cipher.decrypt(row.privateKeyCiphertext)),
          ),
        };
      });

      const deliver = (
        vapid: VapidKeys,
        subscription: typeof pushSubscriptions.$inferSelect,
        payload: Uint8Array,
      ) =>
        Effect.gen(function* () {
          const target = yield* resolvePublicHttpUrl(subscription.endpoint);
          const body = encryptPushPayload({
            plaintext: payload,
            receiverPublicKey: fromBase64url(subscription.p256dh),
            authSecret: fromBase64url(subscription.auth),
          });
          const site = publicUrl();
          const response = yield* Effect.tryPromise(() =>
            fetchPinned(target, {
              method: "POST",
              headers: {
                Authorization: vapidAuthorization({
                  endpoint: target.url,
                  keys: vapid,
                  subject: site?.startsWith("https:") ? site : undefined,
                }),
                "Content-Encoding": "aes128gcm",
                "Content-Type": "application/octet-stream",
                "Content-Length": String(body.length),
                // A run's news is stale after a day; a phone offline longer gets nothing.
                TTL: "86400",
                Urgency: "normal",
              },
              body: new Uint8Array(body),
              signal: AbortSignal.timeout(10_000),
            }),
          );
          void response.body?.cancel();
          // Gone for good: the browser unsubscribed or the person cleared it.
          if (response.status === 404 || response.status === 410)
            yield* db
              .delete(pushSubscriptions)
              .where(eq(pushSubscriptions.id, subscription.id))
              .pipe(Effect.orDie);
          else if (!response.ok)
            yield* Effect.logWarning("push service refused a notification", {
              status: response.status,
              origin: target.url.origin,
            });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("push notification could not be sent", cause),
          ),
        );

      return PushService.of({
        publicKey: Effect.map(keys, (pair) => base64url(pair.publicKey)),
        subscribe: Effect.fn("PushService.subscribe")(function* (
          { userId, sessionId },
          subscription,
        ) {
          const endpoint = yield* resolvePublicHttpUrl(subscription.endpoint).pipe(
            Effect.mapError(() => new PushRejected({ reason: "this push address is not allowed" })),
          );
          if (endpoint.url.protocol !== "https:")
            return yield* new PushRejected({ reason: "push addresses must use https" });
          const p256dh = fromBase64url(subscription.p256dh);
          if (
            p256dh.length !== 65 ||
            p256dh[0] !== 4 ||
            fromBase64url(subscription.auth).length !== 16
          )
            return yield* new PushRejected({ reason: "the subscription keys are malformed" });
          yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx
                  .insert(pushSubscriptions)
                  .values({ id: uuidv7(), userId, sessionId, ...subscription })
                  .onConflictDoUpdate({
                    target: pushSubscriptions.endpoint,
                    set: {
                      userId,
                      sessionId,
                      p256dh: subscription.p256dh,
                      auth: subscription.auth,
                    },
                  });
                const kept = yield* tx
                  .select({ id: pushSubscriptions.id })
                  .from(pushSubscriptions)
                  .where(eq(pushSubscriptions.userId, userId))
                  .orderBy(sql`${pushSubscriptions.createdAt} desc`)
                  .limit(MAX_SUBSCRIPTIONS);
                yield* tx.delete(pushSubscriptions).where(
                  and(
                    eq(pushSubscriptions.userId, userId),
                    notInArray(
                      pushSubscriptions.id,
                      kept.map((row) => row.id),
                    ),
                  ),
                );
              }),
            )
            .pipe(Effect.orDie);
        }),
        send: Effect.fn("PushService.send")(function* (userId, notification) {
          const subscriptions = yield* db
            .select()
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .pipe(Effect.orDie);
          if (subscriptions.length === 0) return;
          const vapid = yield* keys;
          const payload = new TextEncoder().encode(JSON.stringify(notification));
          yield* Effect.forEach(subscriptions, (each) => deliver(vapid, each, payload), {
            concurrency: 4,
            discard: true,
          });
        }),
      });
    }),
  );
}
