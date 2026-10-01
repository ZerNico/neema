import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { isSummary } from "./inspection.ts";
import { createPresentationRuntime } from "./runtime.ts";
import type { PoolWorker } from "~/server/worker-pool.ts";

const workerUrl = new URL("./runtime-worker.ts", import.meta.url);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("presentation worker runtime", () => {
  it("creates, edits, inspects and renders an approximate PNG in persistent workers", async () => {
    const runtime = createPresentationRuntime(workerUrl, { workers: 1 });
    try {
      const created = await runtime.run({ kind: "create" });
      const caller = created.slice();
      const inspected = await runtime.run({ kind: "inspect", bytes: created });
      // The worker gets its own copy; the caller's bytes stay usable.
      expect(created).toEqual(caller);
      const id = inspected.slides[0]!.slideId;
      const edited = await runtime.run({
        kind: "edit",
        bytes: created,
        operations: [
          { kind: "addText", slideId: id, text: "Worker", x: 30, y: 30, width: 150, height: 35 },
        ],
      });
      const described = await runtime.run({
        kind: "inspect",
        bytes: edited.bytes,
        scope: { slides: { ids: [id] }, shapes: true },
      });
      const slide = described.slides[0]!;
      expect(isSummary(slide) && slide.shapes?.map((shape) => shape.text)).toContain("Worker");
      const rendered = await runtime.run({ kind: "render", bytes: edited.bytes, slideIds: [id] });
      expect(rendered[0]?.png.subarray(0, 8)).toEqual(PNG);
      expect(rendered[0]?.warning).toMatch(/Approximate/);
    } finally {
      await runtime.close();
    }
  });

  it("rejects bad work as a promise, cancelled work, and workers that cannot start", async () => {
    const runtime = createPresentationRuntime(workerUrl);
    // Validation failures reject rather than throw, like every other failure.
    const invalid = runtime.run({ kind: "edit", bytes: new Uint8Array(30), operations: "nope" });
    await expect(invalid).rejects.toMatchObject({ code: "invalid_operation" });
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run({ kind: "create" }, controller.signal)).rejects.toMatchObject({
      code: "cancelled",
    });
    await runtime.close();
    await expect(runtime.run({ kind: "create" })).rejects.toMatchObject({
      code: "worker_unavailable",
    });
    const broken = createPresentationRuntime(new URL("./missing-worker.mjs", import.meta.url));
    try {
      await expect(broken.run({ kind: "create" })).rejects.toMatchObject({
        code: expect.stringMatching(/^worker_(error|exit)$/),
      });
    } finally {
      await broken.close();
    }
  });

  it("lets one person run two jobs at once and queues the rest, never another's", async () => {
    // Workers that hold every job until the test answers it.
    const held: Array<{ id: number; reply: (message: object) => void }> = [];
    const runtime = createPresentationRuntime(workerUrl, {
      workers: 6,
      spawn: () => {
        const events = new EventEmitter();
        return {
          on: ((event: string, listener: () => void) =>
            events.on(event, listener)) as PoolWorker["on"],
          postMessage: (message: unknown) => {
            const { id } = message as { id: number };
            held.push({ id, reply: (reply) => events.emit("message", { id, ...reply }) });
          },
          terminate: async () => {},
        };
      },
    });
    const done = { ok: true, result: { kind: "bytes", bytes: new Uint8Array([1]) } };
    const settled: string[] = [];
    const run = (owner: string, name: string) =>
      runtime.run({ kind: "create" }, undefined, { owner }).then(() => settled.push(name));
    const jobs = [run("a", "a1"), run("a", "a2"), run("a", "a3"), run("b", "b1")];
    await vi.waitFor(() => expect(held).toHaveLength(3));
    // a3 waits for one of a's own; b1 did not wait for a at all.
    held[0]!.reply(done);
    await vi.waitFor(() => expect(held).toHaveLength(4));
    for (const job of held.slice(1)) job.reply(done);
    await Promise.all(jobs);
    expect(settled).toHaveLength(4);
    await runtime.close();
  });
});
