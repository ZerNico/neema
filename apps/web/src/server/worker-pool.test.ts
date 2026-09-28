import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createWorkerPool, type WorkerFailure } from "./worker-pool.ts";

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

const pool = (size = 1, queue = 4) =>
  createWorkerPool({
    size,
    queue,
    spawn: () => new Worker(source, { eval: true }),
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

  it("times out a job that never answers and replaces its worker", async () => {
    const workers = pool();
    try {
      await expect(job(workers, "spin", { timeoutMs: 50 }).result).rejects.toThrow("timeout");
      await expect(job(workers, "answer", { value: "next" }).result).resolves.toBe("next");
    } finally {
      await workers.close();
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
