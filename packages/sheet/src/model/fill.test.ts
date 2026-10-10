import { describe, expect, it } from "vitest";
import { DE_DE } from "../locales.ts";
import { applyChange } from "./apply.ts";
import { calculateSheet } from "./calc.ts";
import { fillSeries, type FillDirection, type FillMode } from "./fill.ts";
import { parseFormula, renderFormula } from "./formula.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
/** A sheet with these values down column A from A1 (or across row 1). */
const sheetOf = (values: Array<string | number>, across = false, format?: string) => {
  let doc = emptyDoc();
  doc = apply(doc, {
    op: "set",
    sh: "s1",
    cells: values.map((value, index) => {
      const [r, c] = across ? [id("r", 1), id("c", index + 1)] : [id("r", index + 1), id("c", 1)];
      if (typeof value === "string" && value.startsWith("=")) {
        const parsed = parseFormula(value.slice(1), { doc, sheet: "s1" });
        if (!("formula" in parsed)) throw new Error("growth");
        return { r, c, f: parsed.formula };
      }
      return { r, c, v: value };
    }),
  });
  if (format)
    doc = apply(doc, {
      op: "format",
      sh: "s1",
      area: { r1: id("r", 1), r2: id("r", values.length), c1: id("c", 1), c2: id("c", 1) },
      patch: { numberFormat: format },
    });
  return doc;
};
/** What the cells read after filling `count` on from the first `length` cells. */
const filled = (
  doc: SheetDoc,
  length: number,
  count: number,
  direction: FillDirection = "down",
  mode: FillMode = "auto",
  start = 1,
) => {
  const vertical = direction === "down" || direction === "up";
  const source = vertical
    ? { r1: id("r", start), r2: id("r", start + length - 1), c1: id("c", 1), c2: id("c", 1) }
    : { r1: id("r", 1), r2: id("r", 1), c1: id("c", start), c2: id("c", start + length - 1) };
  const after = apply(doc, ...fillSeries(doc, "s1", source, direction, count, mode, DE_DE));
  const values = calculateSheet(after, { revision: 1, epoch: 0, now: 45_000, seed: 1 });
  const read = (n: number) =>
    vertical
      ? values.value("s1", id("r", n), id("c", 1))
      : values.value("s1", id("r", 1), id("c", n));
  return { after, read };
};
const run = (doc: SheetDoc, length: number, count: number, mode: FillMode = "auto") => {
  const { read } = filled(doc, length, count, "down", mode);
  return Array.from({ length: length + count }, (_, n) => read(n + 1));
};

describe("filling as the fill handle does", () => {
  it("copies one number, counts on from two, and swaps the two with Ctrl", () => {
    expect(run(sheetOf([5]), 1, 3)).toEqual([5, 5, 5, 5]);
    expect(run(sheetOf([5]), 1, 3, "alternate")).toEqual([5, 6, 7, 8]);
    expect(run(sheetOf([1, 3]), 2, 3)).toEqual([1, 3, 5, 7, 9]);
    expect(run(sheetOf([0.1, 0.2]), 2, 2)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(run(sheetOf([1, 3]), 2, 2, "alternate")).toEqual([1, 3, 1, 3]);
    // Uneven steps follow the best straight line, as Excel's linear trend does.
    expect(run(sheetOf([1, 2, 4]), 3, 1)).toEqual([1, 2, 4, 5.3333333333]);
  });

  it("counts dates by day, or by month when they step by whole months", () => {
    // 45000 is 2023-03-15.
    expect(run(sheetOf([45_000], false, "yyyy-mm-dd"), 1, 2)).toEqual([45_000, 45_001, 45_002]);
    const jan31 = 44_957; // 2023-01-31
    const feb28 = 44_985; // 2023-02-28
    const months = run(sheetOf([44_927, 44_958], false, "yyyy-mm-dd"), 2, 2); // Jan 1, Feb 1
    expect(months).toEqual([44_927, 44_958, 44_986, 45_017]);
    expect(run(sheetOf([jan31], false, "d mmm"), 1, 1)).toEqual([jan31, jan31 + 1]);
    expect(feb28).toBe(44_985);
  });

  it("counts numbered text, and day and month names in the sheet's language or English", () => {
    expect(run(sheetOf(["Item 1"]), 1, 2)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(run(sheetOf(["Week 08", "Week 10"]), 2, 1)).toEqual(["Week 08", "Week 10", "Week 12"]);
    expect(run(sheetOf(["Fri"]), 1, 3)).toEqual(["Fri", "Sat", "Sun", "Mon"]);
    expect(run(sheetOf(["JAN", "MAR"]), 2, 2)).toEqual(["JAN", "MAR", "MAY", "JUL"]);
    expect(run(sheetOf(["Montag"]), 1, 1)).toEqual(["Montag", "Dienstag"]);
    expect(run(sheetOf(["Total"]), 1, 2)).toEqual(["Total", "Total", "Total"]);
    expect(run(sheetOf(["Item 1"]), 1, 1, "alternate")).toEqual(["Item 1", "Item 1"]);
  });

  it("repeats formulas, each copy reading its own row, and fills up and across", () => {
    const doc = sheetOf([1, 2, 3, "=A1*10"]);
    const source = { r1: id("r", 4), r2: id("r", 4), c1: id("c", 1), c2: id("c", 1) };
    const after = apply(doc, ...fillSeries(doc, "s1", source, "down", 2));
    expect(
      renderFormula(after.sheet.s1!.cells[id("r", 6)]![id("c", 1)]!.f!, {
        doc: after,
        sheet: "s1",
      }),
    ).toBe("A3*10");
    const { read } = filled(sheetOf([5, 7], true), 2, 2, "right");
    expect([1, 2, 3, 4].map(read)).toEqual([5, 7, 9, 11]);
    const up = sheetOf(["", "", 10, 20]);
    const back = filled(up, 2, 2, "up", "auto", 3).read;
    expect([1, 2, 3, 4].map(back)).toEqual([-10, 0, 10, 20]);
  });

  it("gives each target its source's format", () => {
    const doc = sheetOf([1, 2], false, "0.00");
    const { after } = filled(doc, 2, 1);
    expect(JSON.parse(after.sheet.s1!.cells[id("r", 3)]![id("c", 1)]!.s!)).toEqual({
      numberFormat: "0.00",
    });
  });
});
