import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { rangeText, readRange, readText, textOf } from "./ranges.ts";

const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: 1, ops }, 1).doc;
const doc = apply(emptyDoc(), {
  op: "sheetAdd",
  id: "s2",
  name: "Q1 Sales",
  after: "s1",
  rows: ["s2.r1", "s2.r2", "s2.r3"],
  cols: ["s2.c1", "s2.c2"],
});

describe("chart ranges as people type them", () => {
  it("reads A1 text to IDs and writes it back, naming another sheet", () => {
    const here = readRange(doc, "s1", "$B$2:a4")!;
    expect(here).toEqual({
      sheet: "s1",
      box: { r1: "s1.r2", r2: "s1.r4", c1: "s1.c1", c2: "s1.c2" },
    });
    expect(rangeText(doc, "s1", here.sheet, here.box)).toBe("A2:B4");
    const there = readRange(doc, "s1", "'q1 sales'!A1:B3")!;
    expect(there.sheet).toBe("s2");
    expect(rangeText(doc, "s1", there.sheet, there.box)).toBe("'Q1 Sales'!A1:B3");
    expect(readRange(doc, "s1", "'Q1 Sales'!A1:C9")).toBeNull();
    expect(readRange(doc, "s1", "Nowhere!A1")).toBeNull();
  });

  it("says #REF! once a range's cells are deleted", () => {
    const gone = apply(doc, { op: "delete", sh: "s1", axis: "rows", ids: ["s1.r1"] });
    expect(
      rangeText(gone, "s1", "s1", { r1: "s1.r1", r2: "s1.r3", c1: "s1.c1", c2: "s1.c1" }),
    ).toBe("#REF!");
  });

  it("keeps text as typed, and follows a cell written as =A1", () => {
    expect(readText(doc, "s1", "  Revenue ")).toEqual({ text: "Revenue" });
    const cell = readText(doc, "s1", "=B1");
    expect(cell).toEqual({ cell: { sh: "s1", r: "s1.r1", c: "s1.c2" } });
    expect(textOf(doc, "s1", cell!)).toBe("=B1");
    expect(readText(doc, "s1", "=1+1")).toEqual({ text: "=1+1" });
    expect(readText(doc, "s1", "")).toBeNull();
  });
});
