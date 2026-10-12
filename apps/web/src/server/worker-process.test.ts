import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorkerPool, type PoolWorker, type WorkerReply } from "./worker-pool.ts";
import { forkWorker } from "./worker-process.ts";

// A native wait holds the handler without a large fixture or burning CPU.
const script = `
process.on("message", (message) => {
  if (message.kind === "block") {
    process.send({ id: message.id, entered: true });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  } else process.send({ id: message.id, env: Object.keys(process.env) });
});
`;

let directory: string;
let entry: URL;
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "worker-process-"));
  const path = join(directory, "worker.cjs");
  await writeFile(path, script);
  entry = pathToFileURL(path);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

const pool = (spawned: PoolWorker[] = []) =>
  createWorkerPool({
    size: 1,
    queue: 4,
    spawn: () => {
      const worker = forkWorker(entry, { heapMb: 64 });
      spawned.push(worker);
      return worker;
    },
    failure: (failure) => new Error(failure.reason),
  });
const job = (kind: string, timeoutMs: number) => ({
  message: { kind },
  timeoutMs,
  receive: (reply: WorkerReply) => ({ ok: true as const, value: reply.env as string[] }),
});

describe("worker processes", () => {
  it("kills the exact worker after acknowledged native entry when its job times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawned: PoolWorker[] = [];
    const workers = pool(spawned);
    try {
      const entered = Promise.withResolvers<void>();
      const blocked = workers.run({
        ...job("block", 300),
        receive: (reply: WorkerReply) => {
          if (reply.entered) {
            entered.resolve();
            return undefined;
          }
          throw new Error("Blocked native handler unexpectedly returned");
        },
      });
      const refused = expect(blocked).rejects.toThrow("timeout");
      await entered.promise;
      const exited = new Promise<number>((resolve) => spawned[0]!.on("exit", resolve));
      vi.advanceTimersByTime(300);
      await refused;
      await exited;
      await expect(workers.run(job("echo", 5_000))).resolves.toBeInstanceOf(Array);
      expect(spawned).toHaveLength(2);
    } finally {
      await workers.close();
      await Promise.all(spawned.map((worker) => worker.terminate()));
      vi.useRealTimers();
    }
  }, 15_000);

  it("keeps the server's secrets out of the worker's environment", async () => {
    process.env.WORKER_PROCESS_TEST_SECRET = "hunter2";
    const workers = pool();
    try {
      const env = await workers.run(job("echo", 5_000));
      expect(env).toContain("PATH");
      expect(env).not.toContain("WORKER_PROCESS_TEST_SECRET");
    } finally {
      delete process.env.WORKER_PROCESS_TEST_SECRET;
      await workers.close();
    }
  });
});
