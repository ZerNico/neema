import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { KnowledgeIndexer } from "./indexer.ts";

describe("knowledge worker lifetime", () => {
  it.effect("runs one recovery sweep per interval and stops it with the worker scope", () =>
    Effect.gen(function* () {
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
          }),
        runEmbedding: () =>
          Effect.sync(() => {
            embeddings++;
            return false;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(KnowledgeIndexer.workers.pipe(Layer.provide(indexer)));
          yield* TestClock.adjust(Duration.seconds(11));
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
