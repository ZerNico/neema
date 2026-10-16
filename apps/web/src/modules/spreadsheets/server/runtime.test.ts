import { describe, expect, it } from "vitest";
import { createSpreadsheetRuntime } from "./runtime.ts";

const workerUrl = new URL("./runtime-worker.ts", import.meta.url);

describe("spreadsheet worker runtime", () => {
  it("creates, edits, inspects and previews in a worker process", async () => {
    const runtime = createSpreadsheetRuntime(workerUrl, { workers: 1 });
    try {
      const created = await runtime.run({ kind: "create" });
      const caller = created.slice();
      const edited = await runtime.run({
        kind: "edit",
        bytes: created,
        operations: [{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[2, 3, "=A1*B1"]] }],
      });
      expect(created).toEqual(caller);
      expect(edited.formulaResults).toEqual([
        expect.objectContaining({ cell: "C1", value: "6", formula: "=A1*B1" }),
      ]);
      const inspected = await runtime.run({ kind: "inspect", bytes: edited.bytes });
      expect(inspected.sheets[0]).toMatchObject({ name: "Sheet1", usedRange: "A1:C1" });
      const preview = await runtime.run({ kind: "preview", bytes: edited.bytes });
      expect(preview.cells.map((cell) => cell.value)).toEqual([2, 3, 6]);
    } finally {
      await runtime.close();
    }
  });

  it("refuses a malformed batch before any worker starts", async () => {
    const runtime = createSpreadsheetRuntime(new URL("./missing-worker.mjs", import.meta.url));
    try {
      await expect(
        runtime.run({ kind: "edit", bytes: new Uint8Array(4), operations: [{ kind: "nope" }] }),
      ).rejects.toThrow(/unknown kind/);
    } finally {
      await runtime.close();
    }
  });
});
