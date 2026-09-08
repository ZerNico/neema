import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import { makeGenerationCache } from "./generation-cache.ts";

describe("generation cache bounds", () => {
  it.effect("evicts completed values at capacity and never retains typed failures", () =>
    Effect.gen(function* () {
      const cached = yield* makeGenerationCache<number, string>({ capacity: 1 });
      let attempts = 0;
      const work = Effect.sync(() => ++attempts);
      expect(yield* cached("one", work)).toBe(1);
      expect(yield* cached("one", work)).toBe(1);
      expect(yield* cached("two", work)).toBe(2);
      expect(yield* cached("one", work)).toBe(3);
      expect(yield* Effect.flip(cached("failed", Effect.fail("unavailable")))).toBe("unavailable");
      expect(yield* cached("failed", work)).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.effect("closes pending and uncached overflow producers with their owning generation", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const cached = yield* makeGenerationCache<number>({ capacity: 1 }).pipe(Scope.provide(scope));
      const firstStarted = yield* Deferred.make<void>();
      const overflowStarted = yield* Deferred.make<void>();
      const first = yield* cached(
        "first",
        Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(firstStarted);
      const overflow = yield* cached(
        "overflow",
        Deferred.succeed(overflowStarted, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(overflowStarted);
      yield* Scope.close(scope, Exit.void);
      expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true);
      expect(Exit.isFailure(yield* Fiber.await(overflow))).toBe(true);
      expect(Exit.isFailure(yield* Effect.exit(cached("first", Effect.succeed(1))))).toBe(true);
    }).pipe(Effect.scoped),
  );
});
