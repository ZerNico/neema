import { describe, expect, it } from "vitest";
import { createWordRuntime } from "./runtime.ts";

const workerUrl = new URL("./runtime-worker.ts", import.meta.url);

describe("Word worker runtime", () => {
  it("creates, edits, inspects and previews in a worker process", async () => {
    const runtime = createWordRuntime(workerUrl, { workers: 1 });
    try {
      const created = await runtime.run({ kind: "create" });
      const caller = created.slice();
      const edited = await runtime.run({
        kind: "edit",
        bytes: created,
        operations: [
          {
            kind: "insertParagraphs",
            at: "start",
            paragraphs: [{ text: "Hello **there**", style: "heading1" }],
          },
        ],
      });
      expect(created).toEqual(caller);
      expect(edited.results).toEqual([{ operation: 0, blocks: "0" }]);
      const inspected = await runtime.run({ kind: "inspect", bytes: edited.bytes });
      expect(inspected.outline).toEqual([{ block: 0, level: 1, text: "Hello there" }]);
      const preview = await runtime.run({ kind: "preview", bytes: edited.bytes });
      expect(preview.blocks[0]).toMatchObject({
        role: "heading",
        runs: [{ text: "Hello " }, { text: "there", bold: true }],
      });
    } finally {
      await runtime.close();
    }
  });

  it("refuses a malformed batch before any worker starts", async () => {
    const runtime = createWordRuntime(new URL("./missing-worker.mjs", import.meta.url));
    try {
      await expect(
        runtime.run({ kind: "edit", bytes: new Uint8Array(4), operations: [{ kind: "nope" }] }),
      ).rejects.toThrow(/unknown kind/);
    } finally {
      await runtime.close();
    }
  });
});
