import { Worker } from "node:worker_threads";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { ConfigProvider, Effect, Fiber, Layer } from "effect";
import { CustomToolRuntime } from "./runtime.ts";

/**
 * Hand-written CommonJS bundles, the shape the builder emits, so these tests
 * need no install or type check. `effect` is the one external the worker
 * links.
 */
const module = (functions: string) => `
const { Schema } = require("effect");
module.exports = { default: { ${functions} } };
`;

const tool = (key: string, run: string, parameters = "Schema.Struct({})") => `
  ${key}: {
    name: ${JSON.stringify(key)},
    description: "Test function.",
    parameters: ${parameters},
    run: ${run},
  },`;

const withRuntime = <A, E>(run: Effect.Effect<A, E, CustomToolRuntime>) =>
  run.pipe(
    Effect.provide(
      CustomToolRuntime.layer.pipe(
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CUSTOM_TOOL_WORKERS: 1 }))),
      ),
    ),
  );

const enteredTool = (key: string, run: string) =>
  tool(
    key,
    `async ({ state }) => {
      const words = new Int32Array(state);
      Atomics.store(words, 0, 1);
      Atomics.notify(words, 0);
      ${run}
    }`,
    "Schema.Struct({ state: Schema.Any })",
  );

async function waitForEntry(state: SharedArrayBuffer) {
  const words = new Int32Array(state);
  while (Atomics.load(words, 0) === 0) {
    const waiting = Atomics.waitAsync(words, 0, 0);
    if (waiting.async) await waiting.value;
  }
}

function observeWorkers() {
  const workers: Worker[] = [];
  const exits: Promise<number>[] = [];
  const post = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    ...args
  ) {
    if (!workers.includes(this)) {
      workers.push(this);
      exits.push(new Promise<number>((resolve) => this.once("exit", resolve)));
    }
    post.apply(this, args);
  });
  return {
    workers,
    exits,
    restore: async () => {
      spy.mockRestore();
      await Promise.all(exits);
    },
  };
}

describe("custom tool runtime", () => {
  it.live(
    "keeps warm state, then retires the exact worker after acknowledged handler timeout",
    () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const observed = observeWorkers();
      return withRuntime(
        Effect.gen(function* () {
          const runtime = yield* CustomToolRuntime;
          const compiled = module(
            tool(
              "count",
              "() => { globalThis.__calls = (globalThis.__calls ?? 0) + 1; return globalThis.__calls; }",
            ) + enteredTool("hang", "await new Promise(() => {});"),
          );
          const call = () =>
            runtime.run({ compiled, functionKey: "count", args: {}, timeoutMs: 5_000 });
          expect((yield* call()).output).toBe("1");
          expect((yield* call()).output).toBe("2");
          const state = new SharedArrayBuffer(4);
          const fiber = yield* runtime
            .run({
              compiled,
              functionKey: "hang",
              args: { state },
              timeoutMs: 25,
            })
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => waitForEntry(state));
          vi.advanceTimersByTime(25);
          const timedOut = yield* Fiber.join(fiber);
          expect(timedOut).toMatchObject({
            ok: false,
            error: expect.stringContaining("did not finish"),
          });
          yield* Effect.promise(() => observed.exits[0]!);
          expect((yield* call()).output).toBe("1");
          expect(observed.workers).toHaveLength(2);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            try {
              await observed.restore();
            } finally {
              vi.useRealTimers();
            }
          }),
        ),
      );
    },
  );

  it.effect("replaces a worker whose tool exits the thread, code 0 included", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        const compiled = module(
          tool("quit", "() => { process.exit(0); }") + tool("ping", '() => "pong"'),
        );
        const started = Date.now();
        const quit = yield* runtime.run({
          compiled,
          functionKey: "quit",
          args: {},
          timeoutMs: 30_000,
        });
        expect(quit).toMatchObject({ ok: false, error: expect.stringContaining("exited") });
        // Failed at the exit, not at the deadline.
        expect(Date.now() - started).toBeLessThan(5_000);
        const ping = yield* runtime.run({
          compiled,
          functionKey: "ping",
          args: {},
          timeoutMs: 5_000,
        });
        expect(ping).toMatchObject({ ok: true, output: "pong" });
      }),
    ),
  );

  it.live("fails a call that runs out of memory and keeps serving the next", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        const compiled = module(
          tool("hoard", "() => { const kept = []; for (;;) kept.push(new Array(1e6).fill(1)); }") +
            tool("ping", '() => "pong"'),
        );
        const hoard = yield* runtime.run({
          compiled,
          functionKey: "hoard",
          args: {},
          timeoutMs: 60_000,
        });
        expect(hoard).toMatchObject({ ok: false });
        const ping = yield* runtime.run({
          compiled,
          functionKey: "ping",
          args: {},
          timeoutMs: 5_000,
        });
        expect(ping).toMatchObject({ ok: true, output: "pong" });
      }),
    ),
  );

  it.live("interrupts an acknowledged spinning handler and awaits its exact worker exit", () => {
    const observed = observeWorkers();
    return withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        const state = new SharedArrayBuffer(4);
        const compiled = module(enteredTool("spin", "for (;;) {}") + tool("ping", '() => "pong"'));
        const fiber = yield* runtime
          .run({ compiled, functionKey: "spin", args: { state }, timeoutMs: 60_000 })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => waitForEntry(state));
        yield* Fiber.interrupt(fiber);
        yield* Effect.promise(() => observed.exits[0]!);
        const ping = yield* runtime.run({
          compiled,
          functionKey: "ping",
          args: {},
          timeoutMs: 5_000,
        });
        expect(ping).toMatchObject({ ok: true, output: "pong" });
        expect(observed.workers).toHaveLength(2);
      }),
    ).pipe(Effect.ensuring(Effect.promise(observed.restore)));
  });

  it.live(
    "expires a queued invocation before handler entry without retiring the held worker",
    () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const observed = observeWorkers();
      return withRuntime(
        Effect.gen(function* () {
          const runtime = yield* CustomToolRuntime;
          const heldState = new SharedArrayBuffer(8);
          const queuedState = new SharedArrayBuffer(4);
          const compiled = module(
            enteredTool("hold", "await Atomics.waitAsync(words, 1, 0).value; return 'held';") +
              enteredTool("queued", "return 'should not run';") +
              tool("ping", '() => "pong"'),
          );
          const held = yield* runtime
            .run({ compiled, functionKey: "hold", args: { state: heldState }, timeoutMs: 1_000 })
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => waitForEntry(heldState));
          const submitted = Promise.withResolvers<void>();
          const original = globalThis.setTimeout;
          const timers = vi.spyOn(globalThis, "setTimeout");
          timers.mockImplementation((callback, delay, ...args) => {
            if (delay === 10) submitted.resolve();
            return original(callback, delay, ...args);
          });
          const queued = yield* runtime
            .run({ compiled, functionKey: "queued", args: { state: queuedState }, timeoutMs: 10 })
            .pipe(Effect.forkChild);
          yield* Effect.promise(() => submitted.promise);
          timers.mockRestore();
          vi.advanceTimersByTime(10);
          expect(yield* Fiber.join(queued)).toMatchObject({
            ok: false,
            error: expect.stringContaining("did not finish"),
            durationMs: 10,
          });
          expect(Atomics.load(new Int32Array(queuedState), 0)).toBe(0);
          expect(observed.workers).toHaveLength(1);
          const heldWords = new Int32Array(heldState);
          Atomics.store(heldWords, 1, 1);
          Atomics.notify(heldWords, 1);
          expect(yield* Fiber.join(held)).toMatchObject({ ok: true, output: "held" });
          const ping = yield* runtime.run({
            compiled,
            functionKey: "ping",
            args: {},
            timeoutMs: 1_000,
          });
          expect(ping).toMatchObject({ ok: true, output: "pong" });
          expect(observed.workers).toHaveLength(1);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(async () => {
            try {
              await observed.restore();
            } finally {
              vi.restoreAllMocks();
              vi.useRealTimers();
            }
          }),
        ),
      );
    },
  );

  it.effect("evicts the least recently used module once the byte bound is crossed", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        // Each bundle is padded past a third of the 16 MiB cache so the
        // third load pushes the first out.
        const padding = `/* ${"x".repeat(6 * 1024 * 1024)} */`;
        const bundle = (tag: string) =>
          `${padding}\n${module(
            tool(
              "count",
              `() => { globalThis.__${tag} = (globalThis.__${tag} ?? 0) + 1; return globalThis.__${tag}; }`,
            ),
          )}`;
        const [a, b, c] = [bundle("a"), bundle("b"), bundle("c")];
        const call = (compiled: string) =>
          runtime.run({ compiled, functionKey: "count", args: {}, timeoutMs: 20_000 });

        expect((yield* call(a)).output).toBe("1");
        expect((yield* call(b)).output).toBe("1");
        expect((yield* call(a)).output).toBe("2");
        yield* call(c);
        // `b` was the least recently used; `a` survived and keeps its state.
        expect((yield* call(a)).output).toBe("3");
        expect((yield* call(b)).output).toBe("2");
      }),
    ),
  );

  it.effect("tells an admin to rebuild a bundle whose file runtime predates delivery", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        // What `file()` returned before delivery existed: the brand and `share`.
        const compiled = module(
          tool(
            "export",
            `() => ({ files: [{ [Symbol.for("chat/custom-tools/file")]: true, name: "a.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("a"), share: false }] })`,
          ),
        );
        const result = yield* runtime.run({
          compiled,
          functionKey: "export",
          args: {},
          timeoutMs: 5_000,
        });
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("save it again to rebuild"),
        });
      }),
    ),
  );
});
