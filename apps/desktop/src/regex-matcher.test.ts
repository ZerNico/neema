import { Worker, type WorkerOptions } from "node:worker_threads";
import { Cause, Effect, Exit } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRegexMatcher } from "./regex-matcher.ts";

const trackedWorker = () => {
  const matching = Promise.withResolvers<void>();
  const workers: Worker[] = [];
  const createWorker = (source: string, options: WorkerOptions) => {
    const worker = new Worker(source, options);
    const onMessage = (message: { type: string }) => {
      if (message.type !== "matching") return;
      worker.off("message", onMessage);
      matching.resolve();
    };
    worker.on("message", onMessage);
    workers.push(worker);
    return worker;
  };
  return { createWorker, matching: matching.promise, workers };
};

afterEach(() => vi.useRealTimers());

describe("isolated regexp matching", () => {
  it("keeps JS lookaround, backreferences, line numbers and truncation semantics", async () => {
    const observed = trackedWorker();
    const result = await Effect.runPromise(
      withRegexMatcher(
        "(?<=start )(\\w+) \\1$",
        (match) =>
          Effect.gen(function* () {
            const first = yield* match("no\nstart echo echo\nstart two words", 10);
            const capped = yield* match("start a a\nstart b b\nstart c c", 2);
            return { first, capped };
          }),
        observed,
      ),
    );
    expect(result.first).toEqual({
      matches: [{ line: 2, text: "start echo echo" }],
      truncated: false,
    });
    expect(result.capped).toEqual({
      matches: [
        { line: 1, text: "start a a" },
        { line: 2, text: "start b b" },
      ],
      truncated: true,
    });
    expect(observed.workers).toHaveLength(1);
    expect(observed.workers[0]!.threadId).toBe(-1);
  });

  it("refuses an invalid pattern inside the worker and cleans it up", async () => {
    const observed = trackedWorker();
    const result = await Effect.runPromise(
      Effect.result(withRegexMatcher("(", (match) => match("x", 10), observed)),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "bad-pattern" } });
    expect(observed.workers[0]!.threadId).toBe(-1);
  });

  it("keeps main responsive and terminates the exact busy worker on its parent deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const observed = trackedWorker();
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const controller = new AbortController();
    const result = Effect.runPromise(
      Effect.result(
        withRegexMatcher("(a+)+$", (match) => match("a".repeat(32) + "!", 10), {
          ...observed,
          timeoutMs: 30_000,
        }),
      ),
      { signal: controller.signal },
    );
    try {
      // This acknowledgement comes from the real worker, immediately before its regex test.
      await observed.matching;
      await new Promise<void>((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await result).toMatchObject({ _tag: "Failure", failure: { reason: "timed-out" } });
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(observed.workers[0]!.threadId).toBe(-1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort();
      await result.catch(() => {});
      terminate.mockRestore();
    }
  });

  it("awaits exact-worker termination on cancellation and allows a fresh search", async () => {
    const observed = trackedWorker();
    const terminate = vi.spyOn(Worker.prototype, "terminate");
    const controller = new AbortController();
    const result = Effect.runPromiseExit(
      withRegexMatcher("(a+)+$", (match) => match("a".repeat(32) + "!", 10), observed),
      { signal: controller.signal },
    );
    try {
      await observed.matching;
      controller.abort();
      const exit = await result;
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(terminate).toHaveBeenCalledTimes(1);
      expect(observed.workers[0]!.threadId).toBe(-1);
      const next = await Effect.runPromise(withRegexMatcher("ok", (match) => match("ok", 10)));
      expect(next.matches).toEqual([{ line: 1, text: "ok" }]);
    } finally {
      controller.abort();
      await result;
      terminate.mockRestore();
    }
  });

  it("cleans up when the caller fails outside matching", async () => {
    const observed = trackedWorker();
    const result = await Effect.runPromise(
      Effect.result(withRegexMatcher("x", () => Effect.fail("fixture"), observed)),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: "fixture" });
    expect(observed.workers[0]!.threadId).toBe(-1);
  });
});
