import type { WorkSignal } from "~/modules/sync/server/signals.ts";
import { SyncBus } from "~/modules/sync/server/bus.ts";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Layer, PubSub, Stream } from "effect";
import { TestClock } from "effect/testing";
import { KnowledgeIndexer } from "./indexer.ts";

describe("knowledge worker lifetime", () => {
  it.effect("sleeps while idle and wakes the matching stage on a committed work signal", () =>
    Effect.gen(function* () {
      const signals = yield* PubSub.unbounded<WorkSignal>();
      const first = yield* Deferred.make<void>();
      const next = yield* Deferred.make<void>();
      let extractions = 0;
      let embeddings = 0;
      const indexer = Layer.succeed(KnowledgeIndexer, {
        recoverExpiredJobs: () => Effect.void,
        runExtraction: () =>
          Effect.gen(function* () {
            extractions++;
            yield* Deferred.succeed(extractions === 1 ? first : next, undefined);
            return false;
          }),
        runEmbedding: () =>
          Effect.sync(() => {
            embeddings++;
            return false;
          }),
      });
      const bus = Layer.succeed(SyncBus, {
        publish: () => Effect.void,
        publishGlobal: () => Effect.void,
        subscribe: () => Stream.never,
        signals: Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(signals);
            return Stream.make({ type: "ready" } as const).pipe(
              Stream.concat(Stream.fromSubscription(subscription)),
            );
          }),
        ),
      });
      yield* Layer.build(KnowledgeIndexer.workers.pipe(Layer.provide(indexer), Layer.provide(bus)));
      yield* Deferred.await(first);
      yield* TestClock.adjust(Duration.seconds(10));
      expect(extractions).toBe(1);
      const idleEmbeddings = embeddings;
      yield* PubSub.publish(signals, {
        type: "knowledge.work",
        stage: "extraction",
      } satisfies WorkSignal);
      yield* Deferred.await(next);
      expect(extractions).toBe(2);
      expect(embeddings).toBe(idleEmbeddings);
    }).pipe(Effect.scoped),
  );

  it.effect("runs one recovery sweep per interval and stops it with the worker scope", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let recoveries = 0;
      let extractions = 0;
      let embeddings = 0;
      const indexer = Layer.succeed(KnowledgeIndexer, {
        recoverExpiredJobs: () =>
          Effect.sync(() => {
            recoveries++;
          }),
        runExtraction: () =>
          Effect.sync(() => {
            extractions++;
            return false;
          }).pipe(Effect.tap(() => Deferred.succeed(started, undefined))),
        runEmbedding: () =>
          Effect.sync(() => {
            embeddings++;
            return false;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            KnowledgeIndexer.workers.pipe(
              Layer.provide(indexer),
              Layer.provide(
                Layer.succeed(SyncBus, {
                  publish: () => Effect.void,
                  publishGlobal: () => Effect.void,
                  subscribe: () => Stream.never,
                  signals: Stream.make({ type: "ready" } as const).pipe(
                    Stream.concat(Stream.never),
                  ),
                }),
              ),
            ),
          );
          yield* Deferred.await(started);
          yield* TestClock.adjust(Duration.seconds(61));
          expect(recoveries).toBe(3);
          expect(extractions).toBe(3);
          expect(embeddings).toBeGreaterThan(3);
        }),
      );
      const settled = { recoveries, extractions, embeddings };
      yield* TestClock.adjust(Duration.seconds(20));
      expect({ recoveries, extractions, embeddings }).toEqual(settled);
    }),
  );
});
