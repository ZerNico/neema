import { PgClient } from "@effect/sql-pg";
import { Context, Deferred, Duration, Effect, Layer, PubSub, Schema, Stream } from "effect";
import { type SyncEvent } from "../events.ts";
import { listenNotifications } from "./listener.ts";
import { Notification, NOTIFICATION_CHANNEL, type WorkSignal } from "./signals.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Notification));
type Ready = { type: "ready" };
type Relayed = Notification | Ready;

export class SyncBus extends Context.Service<
  SyncBus,
  {
    publish(userId: string, event: SyncEvent): Effect.Effect<void>;
    publishGlobal(event: SyncEvent): Effect.Effect<void>;
    subscribe(userId: string, userOnly?: boolean): Stream.Stream<SyncEvent>;
    signals: Stream.Stream<WorkSignal | Ready>;
  }
>()("chat/sync/SyncBus") {
  static readonly layer = Layer.effect(
    SyncBus,
    Effect.gen(function* () {
      const pg = yield* PgClient.PgClient;
      const pubsub = yield* PubSub.sliding<{ sequence: number; event: Relayed }>(4096);
      // Ends every open feed with this layer. A dev hot swap disposes it while
      // tabs stay connected; without this they keep a silent feed alive on the
      // heartbeat and never reconnect to the new runtime.
      yield* Effect.addFinalizer(() => PubSub.shutdown(pubsub));
      let sequence = 0;
      const relay = (event: Relayed) =>
        Effect.suspend(() => PubSub.publish(pubsub, { sequence: ++sequence, event }));
      const ready = yield* Deferred.make<void>();
      const listen = listenNotifications(pg.config).pipe(
        Stream.mapEffect((frame) =>
          frame.type === "ready"
            ? relay(frame).pipe(Effect.andThen(Deferred.succeed(ready, undefined)))
            : decode(frame.payload).pipe(
                Effect.flatMap(relay),
                Effect.catch(() => Effect.logWarning("Ignoring invalid sync notification")),
              ),
        ),
        Stream.runDrain,
        Effect.catchCause((cause) => Effect.logWarning("Sync connection lost", cause)),
        Effect.andThen(Effect.sleep(Duration.seconds(1))),
        Effect.forever,
      );
      yield* Effect.forkScoped(listen);
      yield* Deferred.await(ready);
      const publish = (userId: string, event: SyncEvent) =>
        pg
          .notify(NOTIFICATION_CHANNEL, JSON.stringify({ scope: "user", userId, event }))
          .pipe(Effect.orDie);
      const publishGlobal = (event: SyncEvent) =>
        pg
          .notify(NOTIFICATION_CHANNEL, JSON.stringify({ scope: "global", event }))
          .pipe(Effect.orDie);
      const events = Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          let previous = sequence;
          return Stream.make({ type: "ready" } as const).pipe(
            Stream.concat(
              Stream.fromSubscription(subscription).pipe(
                Stream.flatMap((frame) => {
                  // A slow consumer must reconcile if the bounded local queue drops hints.
                  const missed = frame.sequence > previous + 1;
                  previous = frame.sequence;
                  const frames: Relayed[] = missed
                    ? [{ type: "ready" }, frame.event]
                    : [frame.event];
                  return Stream.fromIterable(frames);
                }),
              ),
            ),
          );
        }),
      );
      const subscribe = (userId: string, userOnly = false) =>
        events.pipe(
          Stream.flatMap((envelope) => {
            if ("type" in envelope) return Stream.make({ type: "sync.ready" as const });
            if (
              (!userOnly && envelope.scope === "global") ||
              (envelope.scope === "user" && envelope.userId === userId)
            )
              return Stream.make(envelope.event);
            return Stream.empty;
          }),
        );
      const signals = events.pipe(
        Stream.flatMap((envelope): Stream.Stream<WorkSignal | Ready> =>
          "type" in envelope
            ? Stream.make(envelope)
            : envelope.scope === "internal"
              ? Stream.make(envelope.event)
              : Stream.empty,
        ),
      );
      return SyncBus.of({ publish, publishGlobal, subscribe, signals });
    }),
  );
}
