import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Fiber, Layer } from "effect";
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

const tool = (key: string, run: string) => `
  ${key}: {
    name: ${JSON.stringify(key)},
    description: "Test function.",
    parameters: Schema.Struct({}),
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

describe("custom tool runtime", () => {
  it.effect("keeps module state across warm calls and drops it after replacement", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        const compiled = module(
          tool(
            "count",
            "() => { globalThis.__calls = (globalThis.__calls ?? 0) + 1; return globalThis.__calls; }",
          ) + tool("hang", "() => new Promise(() => {})"),
        );
        const call = () =>
          runtime.run({ compiled, functionKey: "count", args: {}, timeoutMs: 5_000 });

        expect((yield* call()).output).toBe("1");
        expect((yield* call()).output).toBe("2");

        const timedOut = yield* runtime.run({
          compiled,
          functionKey: "hang",
          args: {},
          timeoutMs: 25,
        });
        expect(timedOut).toMatchObject({
          ok: false,
          error: expect.stringContaining("did not finish"),
        });
        // A fresh worker: the counter starts over.
        expect((yield* call()).output).toBe("1");
      }),
    ),
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

  // Live clock: the sleep below has to actually elapse.
  it.live("interruption terminates the running job and frees the slot", () =>
    withRuntime(
      Effect.gen(function* () {
        const runtime = yield* CustomToolRuntime;
        const compiled = module(
          tool("spin", "() => { for (;;) {} }") + tool("ping", '() => "pong"'),
        );
        const released = yield* Deferred.make<void>();
        const fiber = yield* runtime
          .run({ compiled, functionKey: "spin", args: {}, timeoutMs: 60_000 })
          .pipe(Effect.ensuring(Deferred.succeed(released, undefined)), Effect.forkChild);
        // Let the job reach the worker before interrupting it.
        yield* Effect.sleep("100 millis");
        yield* Fiber.interrupt(fiber);
        yield* Deferred.await(released);

        // With one worker, this would queue forever if the spin were still running.
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
