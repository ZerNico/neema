import { describe, expect, it } from "vitest";
import { isSummary } from "./inspection.ts";
import { createPresentationRuntime } from "./runtime.ts";

const workerUrl = new URL("./runtime-worker.ts", import.meta.url);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("presentation worker runtime", () => {
  it("creates, edits, inspects and renders an approximate PNG in persistent workers", async () => {
    const runtime = createPresentationRuntime(workerUrl, { workers: 1 });
    try {
      const created = await runtime.run({ kind: "create" });
      if (created.kind !== "bytes") throw new Error("Expected a deck.");
      const caller = created.bytes.slice();
      const inspected = await runtime.run({ kind: "inspect", bytes: created.bytes });
      if (inspected.kind !== "inspection") throw new Error("Expected an inspection.");
      // The worker gets its own copy; the caller's bytes stay usable.
      expect(created.bytes).toEqual(caller);
      const id = inspected.inspection.slides[0]!.slideId;
      const edited = await runtime.run({
        kind: "edit",
        bytes: created.bytes,
        operations: [
          { kind: "addText", slideId: id, text: "Worker", x: 30, y: 30, width: 150, height: 35 },
        ],
      });
      if (edited.kind !== "edited") throw new Error("Expected an edit.");
      const described = await runtime.run({
        kind: "inspect",
        bytes: edited.bytes,
        scope: { slides: { ids: [id] }, shapes: true },
      });
      if (described.kind !== "inspection") throw new Error("Expected an inspection.");
      const slide = described.inspection.slides[0]!;
      expect(isSummary(slide) && slide.shapes?.map((shape) => shape.text)).toContain("Worker");
      const rendered = await runtime.run({ kind: "render", bytes: edited.bytes, slideIds: [id] });
      if (rendered.kind !== "rendered") throw new Error("Expected a render.");
      expect(rendered.slides[0]?.png.subarray(0, 8)).toEqual(PNG);
      expect(rendered.slides[0]?.warning).toMatch(/Approximate/);
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
});
