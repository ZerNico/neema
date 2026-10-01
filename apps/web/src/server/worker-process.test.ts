import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerPool, type WorkerReply } from "./worker-pool.ts";
import { forkWorker } from "./worker-process.ts";

// A worker that burns CPU inside native code on request: what a thread's
// terminate() cannot interrupt, and the reason previews run in processes.
const script = `
process.on("message", (message) => {
  if (message.kind === "block") require("node:crypto").pbkdf2Sync("x", "y", 1e9, 64, "sha512");
  process.send({ id: message.id, env: Object.keys(process.env) });
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

const pool = () =>
  createWorkerPool({
    size: 1,
    queue: 4,
    spawn: () => forkWorker(entry, { heapMb: 64 }),
    failure: (failure) => new Error(failure.reason),
  });
const job = (kind: string, timeoutMs: number) => ({
  message: { kind },
  timeoutMs,
  receive: (reply: WorkerReply) => ({ ok: true as const, value: reply.env as string[] }),
});

describe("worker processes", () => {
  it("kills a worker stuck in native code when its job times out", async () => {
    const workers = pool();
    const started = Date.now();
    await expect(workers.run(job("block", 300))).rejects.toThrow("timeout");
    // The pool replaced it: the next job runs in a fresh process straight away.
    await expect(workers.run(job("echo", 5_000))).resolves.toBeInstanceOf(Array);
    await workers.close();
    // Nowhere near the minutes the blocked process would have kept burning.
    expect(Date.now() - started).toBeLessThan(10_000);
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
