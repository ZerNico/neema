import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createWorkerPool, type PoolWorker, type WorkerFailure } from "./worker-pool.ts";

// Says it started, then does what the job asks: answer, hang, spin or exit.
const source = `
const { parentPort } = require("node:worker_threads");
parentPort.on("message", (job) => {
  parentPort.postMessage({ id: job.id, started: true });
  if (job.act === "answer") parentPort.postMessage({ id: job.id, value: job.value });
  if (job.act === "spin") for (;;) {}
  if (job.act === "exit") process.exit(3);
});
`;

const pool = (size = 1, queue = 4, spawned: Worker[] = []) =>
  createWorkerPool({
    size,
    queue,
    spawn: () => {
      const worker = new Worker(source, { eval: true });
      spawned.push(worker);
      return worker;
    },
    failure: (failure: WorkerFailure) => new Error(failure.reason),
  });

type Pool = ReturnType<typeof pool>;
/** Runs one job; `started` resolves once the worker has picked it up. */
function job(
  target: Pool,
  act: string,
  options: { signal?: AbortSignal; background?: boolean; timeoutMs?: number; value?: unknown } = {},
) {
  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const result = target.run<unknown>({
    message: { act, value: options.value },
    timeoutMs: options.timeoutMs ?? 10_000,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.background ? { background: true } : {}),
    receive: (reply) => {
      if (reply.started) {
        started();
        return undefined;
      }
      return { ok: true, value: reply.value };
    },
  });
  return { result, running };
}

function controlledPool() {
  const workers: Array<{
    events: EventEmitter;
    posted: Array<{ id: number }>;
    terminate: ReturnType<typeof vi.fn<PoolWorker["terminate"]>>;
  }> = [];
  const target = createWorkerPool({
    size: 1,
    queue: 4,
    failure: (failure) => new Error(failure.reason),
    spawn: () => {
      const events = new EventEmitter();
      const posted: Array<{ id: number }> = [];
      const terminate = vi.fn(async () => {
        events.emit("exit", 1);
      });
      workers.push({ events, posted, terminate });
      return {
        on: (event, listener) => events.on(event, listener),
        postMessage: (message) => posted.push(message as { id: number }),
        terminate,
      };
    },
  });
  const submit = (
    options: { deadline?: number; background?: boolean; signal?: AbortSignal } = {},
  ) =>
    target.run({
      message: {},
      timeoutMs: 100,
      ...options,
      receive: (reply) => ({ ok: true, value: reply.value }),
    });
  return { target, workers, submit };
}

describe("worker pool shutdown", () => {
  it.each([false, true])("awaits retired worker termination (rejects %s)", async (rejects) => {
    const { target, workers, submit } = controlledPool();
    const controller = new AbortController();
    const active = submit({ signal: controller.signal });
    const cancelled = expect(active).rejects.toThrow("cancelled");
    const stopped = Promise.withResolvers<void>();
    workers[0]!.terminate.mockImplementation(() => stopped.promise);
    const closed = vi.fn();
    controller.abort();
    const closing = target.close().then(closed);
    try {
      await cancelled;
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
      expect(closed).not.toHaveBeenCalled();
    } finally {
      if (rejects) stopped.reject(new Error("termination failed"));
      else stopped.resolve();
      await closing;
    }
    expect(closed).toHaveBeenCalledTimes(1);
  });
});

describe("worker pool deadlines", () => {
  it.each([false, true])(
    "expires queued work without retiring another job (background %s)",
    async (background) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { target, workers, submit } = controlledPool();
      try {
        const held = submit();
        const controller = new AbortController();
        const queued = submit({ deadline: 1_010, background, signal: controller.signal });
        const expired = expect(queued).rejects.toThrow("timeout");
        vi.advanceTimersByTime(10);
        await expired;
        controller.abort();
        expect(workers[0]!.posted).toHaveLength(1);
        expect(workers[0]!.terminate).not.toHaveBeenCalled();
        workers[0]!.events.emit("message", { id: workers[0]!.posted[0]!.id, value: "held" });
        await expect(held).resolves.toBe("held");
        expect(workers[0]!.posted).toHaveLength(1);
        const next = submit();
        workers[0]!.events.emit("message", { id: workers[0]!.posted[1]!.id, value: "next" });
        await expect(next).resolves.toBe("next");
      } finally {
        await target.close();
        vi.useRealTimers();
      }
    },
  );

  it("dispatches with only the remaining budget and ignores stale replies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { target, workers, submit } = controlledPool();
    try {
      const held = submit();
      const queued = submit({ deadline: 1_050 });
      const expired = expect(queued).rejects.toThrow("timeout");
      vi.advanceTimersByTime(40);
      const worker = workers[0]!;
      worker.events.emit("message", { id: worker.posted[0]!.id, value: "held" });
      await held;
      expect(worker.posted).toHaveLength(2);
      worker.events.emit("message", { id: worker.posted[0]!.id, value: "stale" });
      vi.advanceTimersByTime(9);
      expect(worker.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      await expired;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      await target.close();
      vi.useRealTimers();
    }
  });

  it("refuses expired work even when delivery of its queued timer is delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { target, workers, submit } = controlledPool();
    try {
      const held = submit();
      const queued = submit({ deadline: 1_010 });
      const expired = expect(queued).rejects.toThrow("timeout");
      vi.setSystemTime(1_040);
      workers[0]!.events.emit("message", { id: workers[0]!.posted[0]!.id });
      await held;
      await expired;
      await expect(submit({ deadline: 1_030 })).rejects.toThrow("timeout");
      expect(workers[0]!.posted).toHaveLength(1);
      expect(workers[0]!.terminate).not.toHaveBeenCalled();
    } finally {
      await target.close();
      vi.useRealTimers();
    }
  });

  it.each([1_010, 1_011])(
    "expires an active reply before receive without timeout delivery (clock %s)",
    async (now) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { target, workers, submit } = controlledPool();
      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const receive = vi.fn(() => ({ ok: true as const, value: "late success" }));
      try {
        const active = target.run({
          message: {},
          timeoutMs: 100,
          deadline: 1_010,
          signal: controller.signal,
          receive,
        });
        const expired = expect(active).rejects.toThrow("timeout");
        const worker = workers[0]!;
        vi.setSystemTime(now);
        worker.events.emit("message", { id: worker.posted[0]!.id, value: "late success" });
        await expired;
        expect(receive).not.toHaveBeenCalled();
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        expect(removed).toHaveBeenCalledTimes(1);
        const next = submit();
        controller.abort();
        worker.events.emit("message", { id: worker.posted[0]!.id, value: "stale" });
        expect(worker.terminate).toHaveBeenCalledTimes(1);
        const replacement = workers[1]!;
        expect(replacement.terminate).not.toHaveBeenCalled();
        replacement.events.emit("message", { id: replacement.posted[0]!.id, value: "next" });
        await expect(next).resolves.toBe("next");
        expect(removed).toHaveBeenCalledTimes(1);
      } finally {
        await target.close();
        removed.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each(["success", "error", "intermediate"])(
    "expires work that crosses its deadline during receive (%s)",
    async (outcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { target, workers } = controlledPool();
      const receive = vi.fn(() => {
        vi.setSystemTime(1_011);
        if (outcome === "intermediate") return undefined;
        return outcome === "success"
          ? { ok: true as const, value: "late success" }
          : { ok: false as const, error: new Error("late failure") };
      });
      try {
        const active = target.run({ message: {}, timeoutMs: 100, deadline: 1_010, receive });
        const expired = expect(active).rejects.toThrow("timeout");
        const worker = workers[0]!;
        worker.events.emit("message", { id: worker.posted[0]!.id });
        await expired;
        expect(receive).toHaveBeenCalledTimes(1);
        expect(worker.terminate).toHaveBeenCalledTimes(1);
      } finally {
        await target.close();
        vi.useRealTimers();
      }
    },
  );

  it("expires an intermediate asynchronous post without timeout delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { target, workers, submit } = controlledPool();
    const prepared = Promise.withResolvers<void>();
    let response: Promise<void> | undefined;
    try {
      const active = target.run({
        message: {},
        timeoutMs: 100,
        deadline: 1_010,
        receive: (_reply, post) => {
          response = prepared.promise.then(() => post({ kind: "file-result" }));
          return undefined;
        },
      });
      const expired = expect(active).rejects.toThrow("timeout");
      const worker = workers[0]!;
      worker.events.emit("message", { id: worker.posted[0]!.id, kind: "file-request" });
      if (!response) throw new Error("Missing intermediate response");
      expect(worker.terminate).not.toHaveBeenCalled();
      vi.setSystemTime(1_011);
      prepared.resolve();
      await response;
      await expired;
      expect(worker.posted).toHaveLength(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      const next = submit();
      const replacement = workers[1]!;
      replacement.events.emit("message", { id: replacement.posted[0]!.id, value: "next" });
      await expect(next).resolves.toBe("next");
    } finally {
      prepared.resolve();
      await target.close();
      await response;
      vi.useRealTimers();
    }
  });

  it("ignores an expired asynchronous post from a completed job on a reused slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { target, workers, submit } = controlledPool();
    const prepared = Promise.withResolvers<void>();
    let response: Promise<void> | undefined;
    try {
      const first = target.run({
        message: {},
        timeoutMs: 100,
        deadline: 1_010,
        receive: (_reply, post) => {
          response = prepared.promise.then(() => post({ kind: "stale" }));
          return { ok: true, value: "first" };
        },
      });
      const worker = workers[0]!;
      worker.events.emit("message", { id: worker.posted[0]!.id });
      await expect(first).resolves.toBe("first");
      if (!response) throw new Error("Missing saved response");
      const next = submit({ deadline: 1_050 });
      vi.setSystemTime(1_011);
      prepared.resolve();
      await response;
      expect(worker.posted).toHaveLength(2);
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.events.emit("message", { id: worker.posted[1]!.id, value: "next" });
      await expect(next).resolves.toBe("next");
      expect(workers).toHaveLength(1);
    } finally {
      prepared.resolve();
      await target.close();
      await response;
      vi.useRealTimers();
    }
  });

  it("does not impose an absolute deadline on intermediate posts or replies without one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { target, workers } = controlledPool();
    const prepared = Promise.withResolvers<void>();
    let response: Promise<void> | undefined;
    try {
      const active = target.run({
        message: {},
        timeoutMs: 100,
        receive: (reply, post) => {
          if (reply.kind !== "file-request") return { ok: true, value: reply.value };
          response = prepared.promise.then(() => post({ kind: "file-result" }));
          return undefined;
        },
      });
      const worker = workers[0]!;
      worker.events.emit("message", { id: worker.posted[0]!.id, kind: "file-request" });
      if (!response) throw new Error("Missing intermediate response");
      vi.setSystemTime(1_101);
      prepared.resolve();
      await response;
      expect(worker.posted).toHaveLength(2);
      expect(worker.terminate).not.toHaveBeenCalled();
      worker.events.emit("message", { id: worker.posted[0]!.id, value: "finished" });
      await expect(active).resolves.toBe("finished");
      expect(worker.terminate).not.toHaveBeenCalled();
    } finally {
      prepared.resolve();
      await target.close();
      await response;
      vi.useRealTimers();
    }
  });

  it("retains an active-only timeout when the caller supplied no deadline", async () => {
    vi.useFakeTimers();
    const { target, workers, submit } = controlledPool();
    try {
      const held = submit();
      const queued = submit();
      const expired = expect(queued).rejects.toThrow("timeout");
      vi.advanceTimersByTime(40);
      workers[0]!.events.emit("message", { id: workers[0]!.posted[0]!.id });
      await held;
      vi.advanceTimersByTime(60);
      expect(workers[0]!.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(40);
      await expired;
      expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    } finally {
      await target.close();
      vi.useRealTimers();
    }
  });

  it("does not settle a reply again after its handler synchronously cancels the job", async () => {
    vi.useFakeTimers();
    const { target, workers, submit } = controlledPool();
    const controller = new AbortController();
    const removed = vi.spyOn(controller.signal, "removeEventListener");
    try {
      const first = target.run({
        message: {},
        timeoutMs: 100,
        signal: controller.signal,
        receive: (_reply, post) => {
          controller.abort();
          post({ stale: true });
          return { ok: true, value: "too late" };
        },
      });
      const refused = expect(first).rejects.toThrow("cancelled");
      const next = submit();
      const old = workers[0]!;
      old.events.emit("message", { id: old.posted[0]!.id });
      await refused;
      expect(removed).toHaveBeenCalledTimes(1);
      expect(old.terminate).toHaveBeenCalledTimes(1);
      expect(old.posted).toHaveLength(1);
      const replacement = workers[1]!;
      expect(replacement.posted).toHaveLength(1);
      replacement.events.emit("message", { id: replacement.posted[0]!.id, value: "next" });
      await expect(next).resolves.toBe("next");
    } finally {
      await target.close();
      removed.mockRestore();
      vi.useRealTimers();
    }
  });

  it("settles once across reply, stale timeout, abort and close", async () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const { target, workers, submit } = controlledPool();
    try {
      const controller = new AbortController();
      const first = submit({ signal: controller.signal });
      const oldTimer = timers.mock.calls[0]![0];
      const worker = workers[0]!;
      worker.events.emit("message", { id: worker.posted[0]!.id, value: "first" });
      await expect(first).resolves.toBe("first");
      const next = submit();
      const refused = expect(next).rejects.toThrow("closed");
      if (typeof oldTimer !== "function") throw new Error("Missing timeout callback");
      oldTimer();
      controller.abort();
      worker.events.emit("message", { id: worker.posted[0]!.id, value: "late" });
      expect(worker.terminate).not.toHaveBeenCalled();
      await target.close();
      await refused;
      oldTimer();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      await target.close();
      timers.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("worker pool", () => {
  it("replaces a worker cancelled mid-job and keeps serving", async () => {
    const workers = pool();
    try {
      const controller = new AbortController();
      const spinning = job(workers, "spin", { signal: controller.signal });
      await spinning.running;
      controller.abort();
      await expect(spinning.result).rejects.toThrow("cancelled");
      await expect(job(workers, "answer", { value: 7 }).result).resolves.toBe(7);
    } finally {
      await workers.close();
    }
  });

  it("times out an acknowledged spin, awaits its exit and replaces its worker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawned: Worker[] = [];
    const workers = pool(1, 4, spawned);
    try {
      const spinning = job(workers, "spin", { timeoutMs: 50 });
      const refused = expect(spinning.result).rejects.toThrow("timeout");
      await spinning.running;
      const exited = new Promise<number>((resolve) => spawned[0]!.once("exit", resolve));
      vi.advanceTimersByTime(50);
      await refused;
      await exited;
      await expect(job(workers, "answer", { value: "next" }).result).resolves.toBe("next");
      expect(spawned).toHaveLength(2);
    } finally {
      await workers.close();
      await Promise.all(spawned.map((worker) => worker.terminate()));
      vi.useRealTimers();
    }
  });

  it("does not mistake a controlled boot timeout for handler containment", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = new SharedArrayBuffer(8);
    const booted = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<number>();
    const workers = createWorkerPool({
      size: 1,
      queue: 1,
      failure: (failure) => new Error(failure.reason),
      spawn: () => {
        const worker = new Worker(
          `
          const { parentPort, workerData } = require("node:worker_threads");
          const words = new Int32Array(workerData);
          parentPort.postMessage({ booted: true });
          Atomics.wait(words, 0, 0);
          parentPort.on("message", (job) => {
            Atomics.store(words, 1, 1);
            parentPort.postMessage({ id: job.id, started: true });
            for (;;) {}
          });
        `,
          { eval: true, workerData: state },
        );
        worker.on("message", (reply) => {
          if (reply.booted) booted.resolve();
        });
        worker.once("exit", exited.resolve);
        return worker;
      },
    });
    try {
      const blocked = job(workers, "spin", { timeoutMs: 50 });
      const refused = expect(blocked.result).rejects.toThrow("timeout");
      await booted.promise;
      expect(Atomics.load(new Int32Array(state), 1)).toBe(0);
      vi.advanceTimersByTime(50);
      await refused;
      await exited.promise;
      expect(Atomics.load(new Int32Array(state), 1)).toBe(0);
    } finally {
      await workers.close();
      await exited.promise;
      vi.useRealTimers();
    }
  });

  it("refuses work beyond each lane's queue as busy", async () => {
    const workers = pool(1, 1);
    const controller = new AbortController();
    try {
      const running = job(workers, "spin", { signal: controller.signal });
      await running.running;
      const queued = job(workers, "answer", { value: 1 });
      await expect(job(workers, "answer").result).rejects.toThrow("busy");
      // The background lane has room of its own.
      const background = job(workers, "answer", { value: 2, background: true });
      controller.abort();
      await expect(running.result).rejects.toThrow("cancelled");
      await expect(queued.result).resolves.toBe(1);
      await expect(background.result).resolves.toBe(2);
    } finally {
      await workers.close();
    }
  });

  it("serves queued foreground work before background work", async () => {
    const workers = pool();
    const controller = new AbortController();
    try {
      const running = job(workers, "spin", { signal: controller.signal });
      await running.running;
      const order: string[] = [];
      const background = job(workers, "answer", { background: true }).result.then(() =>
        order.push("background"),
      );
      const foreground = job(workers, "answer").result.then(() => order.push("foreground"));
      controller.abort();
      await expect(running.result).rejects.toThrow("cancelled");
      await Promise.all([background, foreground]);
      expect(order).toEqual(["foreground", "background"]);
    } finally {
      await workers.close();
    }
  });

  it("fails a job whose worker exits, then rejects everything once closed", async () => {
    const workers = pool();
    await expect(job(workers, "exit").result).rejects.toThrow("exited");
    await expect(job(workers, "answer", { value: "after" }).result).resolves.toBe("after");
    const running = job(workers, "spin");
    await running.running;
    const queued = job(workers, "answer");
    const refused = Promise.all([
      expect(running.result).rejects.toThrow("closed"),
      expect(queued.result).rejects.toThrow("closed"),
    ]);
    await workers.close();
    await refused;
    await expect(job(workers, "answer").result).rejects.toThrow("closed");
  });
});
