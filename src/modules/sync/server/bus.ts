import { PgClient } from "@effect/sql-pg";
import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { type SyncEvent, UserSyncEnvelope } from "../events.ts";

const CHANNEL = "chat_sync";

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(UserSyncEnvelope));
const encodeEnvelope = Schema.encodeEffect(Schema.fromJsonString(UserSyncEnvelope));

// User-scoped event bus. Publishes go to Postgres NOTIFY so every app
// instance (and therefore every connected browser) sees them; each instance
// relays NOTIFY payloads into its local PubSub, which SSE handlers subscribe to.
export class SyncBus extends Context.Service<
  SyncBus,
  {
    publish(userId: string, event: SyncEvent): Effect.Effect<void>;
    subscribe(userId: string): Stream.Stream<SyncEvent>;
  }
>()("chat/sync/SyncBus") {
  static readonly layer = Layer.effect(
    SyncBus,
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;
      // Sliding: a stalled SSE consumer must not buffer events forever. Sync
      // events are invalidation hints, so a dropped one costs a refetch at
      // the next event, not correctness.
      const pubsub = yield* PubSub.sliding<UserSyncEnvelope>(1024);

      // Relay: NOTIFY -> local PubSub. Runs for the lifetime of the layer scope.
      yield* pg.listen(CHANNEL).pipe(
        Stream.mapEffect((payload) => decodeEnvelope(payload)),
        Stream.mapEffect((envelope) => PubSub.publish(pubsub, envelope)),
        Stream.runDrain,
        Effect.catchCause((cause) => Effect.logError("sync relay failed", cause)),
        Effect.forever,
        Effect.forkScoped,
      );

      const publish = Effect.fn("SyncBus.publish")(function* (userId: string, event: SyncEvent) {
        const payload = yield* encodeEnvelope({ userId, event });
        yield* pg.notify(CHANNEL, payload);
      }, Effect.orDie);

      const subscribe = (userId: string) =>
        Stream.fromPubSub(pubsub).pipe(
          Stream.filter((envelope) => envelope.userId === userId),
          Stream.map((envelope) => envelope.event),
        );

      return SyncBus.of({ publish, subscribe });
    }),
  );
}
