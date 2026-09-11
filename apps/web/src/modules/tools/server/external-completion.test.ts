import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { ExternalCompletion } from "./external-completion.ts";

// The wait is what makes a blocked handler safe, so the two properties that
// keep it safe are asserted directly: it always ends, and an answer that
// arrives after it ended lands nowhere.
const withService = <A, E>(
  body: (external: ExternalCompletion["Service"]) => Effect.Effect<A, E, never>,
): Effect.Effect<A, E> =>
  Effect.flatMap(ExternalCompletion, body).pipe(
    Effect.scoped,
    Effect.provide(ExternalCompletion.layer),
  );

const start = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.forkChild(effect, { startImmediately: true });

describe("ExternalCompletion", () => {
  it.effect("returns the answer it was given", () =>
    withService((external) =>
      Effect.gen(function* () {
        const waiting = yield* start(
          external.await("call-1", { timeout: Duration.seconds(5), onTimeout: () => "gave up" }),
        );
        // Wait on the registration rather than on a clock: `await` registers
        // before it blocks, so this is the moment a page could answer.
        yield* Effect.repeat(external.pending("call-1"), { until: (present) => present });
        expect(yield* external.complete("call-1", "answered")).toBe(true);
        expect(yield* Fiber.join(waiting)).toBe("answered");
      }),
    ),
  );

  it.effect("gives up with a readable value rather than an exception", () =>
    withService((external) =>
      Effect.gen(function* () {
        const waiting = yield* start(
          external.await("call-2", { timeout: Duration.minutes(2), onTimeout: () => "gave up" }),
        );
        yield* Effect.repeat(external.pending("call-2"), { until: (present) => present });
        yield* TestClock.adjust(Duration.minutes(2));
        expect(yield* Fiber.join(waiting)).toBe("gave up");
        // The registration went with the wait, so a late answer has nowhere to
        // land: this is what keeps a result off a row already marked terminal.
        expect(yield* external.pending("call-2")).toBe(false);
        expect(yield* external.complete("call-2", "too late")).toBe(false);
      }),
    ),
  );

  it.effect("drops an answer to a call nobody made", () =>
    withService((external) =>
      Effect.map(external.complete("never-registered", "hello"), (accepted) => {
        expect(accepted).toBe(false);
      }),
    ),
  );

  it.effect("deregisters when the waiting handler is interrupted", () =>
    withService((external) =>
      Effect.gen(function* () {
        const waiting = yield* start(
          external.await("call-3", { timeout: Duration.minutes(1), onTimeout: () => "gave up" }),
        );
        yield* Effect.repeat(external.pending("call-3"), { until: (present) => present });
        yield* Fiber.interrupt(waiting);
        expect(yield* external.pending("call-3")).toBe(false);
        expect(yield* external.complete("call-3", "too late")).toBe(false);
      }),
    ),
  );

  it.effect("keeps concurrent calls apart", () =>
    withService((external) =>
      Effect.gen(function* () {
        const both = yield* start(
          Effect.all(
            [
              external.await("a", { timeout: Duration.seconds(5), onTimeout: () => "gave up" }),
              external.await("b", { timeout: Duration.seconds(5), onTimeout: () => "gave up" }),
            ],
            { concurrency: 2 },
          ),
        );
        yield* Effect.repeat(external.pending("b"), { until: (present) => present });
        yield* external.complete("b", "second");
        yield* external.complete("a", "first");
        expect(yield* Fiber.join(both)).toEqual(["first", "second"]);
      }),
    ),
  );
});
