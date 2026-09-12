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

const owner = {
  userId: "u",
  conversationId: "c",
  messageId: "m",
  generationId: "g",
  executorId: "e",
};
const operation = {
  ...owner,
  name: "write_local_file",
  args: { path: "site/a", text: "hello" },
  timeoutMs: 5000,
};

describe("ExternalCompletion", () => {
  it.effect("binds claims and results to every part of the initiating identity", () =>
    withService((external) =>
      Effect.gen(function* () {
        yield* external.track(owner, Effect.void);
        yield* external.open("owned", operation);
        for (const key of [
          "userId",
          "conversationId",
          "messageId",
          "generationId",
          "executorId",
        ] as const)
          expect(yield* external.claim("owned", { ...owner, [key]: "foreign" })).toBeNull();
        expect((yield* external.snapshot("other-user", "e")).calls).toEqual([]);
        expect((yield* external.snapshot("u", "other-machine")).calls).toEqual([]);
        const tokens = yield* Effect.all(
          [external.claim("owned", owner), external.claim("owned", owner)],
          { concurrency: 2 },
        );
        expect(tokens[0]).toBeTruthy();
        expect(tokens[1]).toBe(tokens[0]);
        expect(yield* external.completeClaim("owned", owner, "wrong-token", "bad")).toBe(false);
        expect(yield* external.completeClaim("owned", owner, tokens[0]!, "good")).toBe(true);
        expect(yield* external.completeClaim("owned", owner, tokens[0]!, "duplicate")).toBe(false);
        expect(
          yield* external.await("owned", {
            timeout: Duration.seconds(5),
            onTimeout: () => "timeout",
          }),
        ).toBe("good");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("revokes authority at expiry before a delayed handler starts waiting", () =>
    withService((external) =>
      Effect.gen(function* () {
        yield* external.track(owner, Effect.void);
        yield* external.open("expired", operation);
        const token = yield* external.claim("expired", owner);
        yield* TestClock.adjust(Duration.seconds(5));
        expect(yield* external.claim("expired", owner)).toBeNull();
        expect(yield* external.completeClaim("expired", owner, token!, "late")).toBe(false);
        expect(
          yield* external.await("expired", {
            timeout: Duration.minutes(10),
            onTimeout: () => "timeout",
          }),
        ).toBe("timeout");
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("Stop cancels ownership and rejects every later claim or result", () =>
    withService((external) =>
      Effect.gen(function* () {
        yield* external.track(owner, Effect.void);
        yield* external.open("stopped", operation);
        const token = yield* external.claim("stopped", owner);
        yield* external.cancelAttempt(owner);
        expect(yield* external.claim("stopped", owner)).toBeNull();
        expect(yield* external.completeClaim("stopped", owner, token!, "late")).toBe(false);
        expect((yield* external.snapshot("u", "e")).attempts).toEqual([]);
        expect(
          yield* external.await("unregistered", {
            requireOpen: true,
            timeout: Duration.minutes(10),
            onTimeout: () => "cancelled",
          }),
        ).toBe("cancelled");
        expect(yield* external.pending("unregistered")).toBe(false);
      }).pipe(Effect.scoped),
    ),
  );
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
