import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createJobRuntime, JobError, withRunOptions } from "./jobs.ts";

type Jobs = { echo: (request: { value: number }) => number };

function runtime() {
  const events = new EventEmitter();
  const posted: Array<{ id: number; value: number }> = [];
  const submitted = Promise.withResolvers<void>();
  const target = createJobRuntime<Jobs>({
    entry: new URL("./unused-test-worker.ts", import.meta.url),
    label: "Test work",
    workers: 1,
    perOwner: 1,
    queue: 1,
    timeoutMs: 10_000,
    heapMb: 64,
    errorOf: (code, message) => new JobError(code, message),
    spawn: () => ({
      on: (event, listener) => events.on(event, listener),
      postMessage: (message) => {
        posted.push(message as { id: number; value: number });
        submitted.resolve();
        events.emit("posted");
      },
      terminate: async () => {
        events.emit("exit", 1);
      },
    }),
  });
  const reply = (index: number) =>
    events.emit("message", { id: posted[index]!.id, ok: true, result: posted[index]!.value });
  return { target, posted, events, submitted: submitted.promise, reply };
}

describe("job admission cancellation", () => {
  it("admits useful queued work after refusing a pre-aborted owner request", async () => {
    const { target, posted, events, submitted, reply } = runtime();
    try {
      const active = target.run({ kind: "echo", value: 1 }, undefined, { owner: "owner" });
      await submitted;
      const controller = new AbortController();
      controller.abort();
      await expect(
        target.run({ kind: "echo", value: 2 }, controller.signal, { owner: "owner" }),
      ).rejects.toMatchObject({ code: "cancelled" });
      const useful = target.run({ kind: "echo", value: 3 }, undefined, { owner: "owner" });
      const nextDispatch = new Promise<void>((resolve) => events.once("posted", resolve));
      reply(0);
      await expect(active).resolves.toBe(1);
      await nextDispatch;
      expect(posted).toHaveLength(2);
      reply(1);
      await expect(useful).resolves.toBe(3);
      expect(posted.map((message) => message.value)).toEqual([1, 3]);
    } finally {
      await target.close();
    }
  });

  it("refuses cancellation during an async options handoff before pool dispatch", async () => {
    const { target, posted } = runtime();
    const entered = Promise.withResolvers<void>();
    const loaded = Promise.withResolvers<{ owner: string }>();
    const prepared = withRunOptions(target, async () => {
      entered.resolve();
      return loaded.promise;
    });
    try {
      const controller = new AbortController();
      const result = prepared.run({ kind: "echo", value: 1 }, controller.signal);
      const refused = expect(result).rejects.toMatchObject({ code: "cancelled" });
      await entered.promise;
      controller.abort();
      loaded.resolve({ owner: "owner" });
      await refused;
      expect(posted).toHaveLength(0);
    } finally {
      await target.close();
    }
  });
});
