import { describe, expect, it } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { enterCell, type GridContext } from "./commands.ts";
import { cellStyle } from "./display.ts";
import {
  addConditional,
  autoSum,
  clearConditional,
  editConditional,
  borderSelection,
  decimalsSelection,
  freezeAt,
  mergeSelection,
  selectionStats,
  shiftDecimals,
} from "./format-commands.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const at = (doc: SheetDoc, row: number, col: number) => ({
  r: positions(doc.sheet.s1!.rows).ids[row - 1]!,
  c: positions(doc.sheet.s1!.cols).ids[col - 1]!,
});
const context = (doc: SheetDoc, from: [number, number], to = from): GridContext => ({
  doc,
  sheet: "s1",
  selection: { anchor: at(doc, ...from), head: at(doc, ...to) },
  values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
  locale: EN_US,
  mint: () => `n${++revision}`,
});
const type = (doc: SheetDoc, row: number, col: number, raw: string) =>
  apply(doc, enterCell(context(doc, [row, col]), at(doc, row, col), raw));
const styleAt = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return cellStyle(doc.sheet.s1!.cells[r]?.[c]?.s);
};
const formulaAt = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return renderFormula(doc.sheet.s1!.cells[r]![c]!.f!, { doc, sheet: "s1" });
};

describe("the Home tab's commands", () => {
  it("draws borders around, inside, or on one side of the selection", () => {
    const doc = apply(emptyDoc(), borderSelection(context(emptyDoc(), [1, 1], [2, 2]), "outer"));
    expect(styleAt(doc, 1, 1)).toEqual({ borderTop: true, borderLeft: true });
    expect(styleAt(doc, 2, 2)).toEqual({ borderBottom: true, borderRight: true });
    const inner = apply(emptyDoc(), borderSelection(context(emptyDoc(), [1, 1], [2, 2]), "inner"));
    expect(styleAt(inner, 1, 1)).toEqual({ borderRight: true, borderBottom: true });
    expect(styleAt(inner, 2, 2)).toEqual({});
    const cleared = apply(doc, borderSelection(context(doc, [1, 1], [2, 2]), "none"));
    expect(styleAt(cleared, 1, 1)).toEqual({});
  });

  it("adds and removes decimals in any number format, from what General shows", () => {
    expect(shiftDecimals("#,##0.00 €", 1)).toBe("#,##0.000 €");
    expect(shiftDecimals("0%", 1)).toBe("0.0%");
    expect(shiftDecimals("0.0", -1)).toBe("0");
    expect(shiftDecimals("#,##0.00;[Red]-#,##0.00", -1)).toBe("#,##0.0;[Red]-#,##0.0");
    expect(shiftDecimals("yyyy-mm-dd", 1)).toBe("yyyy-mm-dd");
    const doc = type(emptyDoc(), 1, 1, "1.25");
    const more = apply(doc, decimalsSelection(context(doc, [1, 1]), 1));
    expect(styleAt(more, 1, 1).numberFormat).toBe("0.000");
  });

  it("totals the numbers above a cell, or each column of a range below it", () => {
    let doc = emptyDoc();
    for (const [row, value] of [
      [1, "Sales"],
      [2, "10"],
      [3, "20"],
      [4, "30"],
    ] as const)
      doc = type(doc, row, 1, value);
    const single = apply(doc, autoSum(context(doc, [5, 1])));
    expect(formulaAt(single, 5, 1)).toBe("SUM(A2:A4)");
    doc = type(doc, 2, 2, "1");
    doc = type(doc, 3, 2, "2");
    const columns = apply(doc, autoSum(context(doc, [2, 1], [3, 2]), "AVERAGE"));
    expect([formulaAt(columns, 4, 1), formulaAt(columns, 4, 2)]).toEqual([
      "AVERAGE(A2:A3)",
      "AVERAGE(B2:B3)",
    ]);
  });

  it("merges, merges across rows, centres, and freezes at the active cell", () => {
    const doc = apply(emptyDoc(), mergeSelection(context(emptyDoc(), [1, 1], [2, 3]), "across"));
    expect(doc.sheet.s1!.merges).toHaveLength(2);
    const centred = apply(
      emptyDoc(),
      mergeSelection(context(emptyDoc(), [1, 1], [1, 3]), "center"),
    );
    expect(styleAt(centred, 1, 1).horizontal).toBe("center");
    const frozen = apply(emptyDoc(), freezeAt(context(emptyDoc(), [3, 2]), "selection"));
    expect(frozen.sheet.s1!.freeze).toEqual({ row: "s1.r2", col: "s1.c1" });
  });

  it("sums, averages and counts a selection for the status bar", () => {
    let doc = emptyDoc();
    for (const [row, value] of [
      [1, "Label"],
      [2, "10"],
      [3, "20"],
    ] as const)
      doc = type(doc, row, 1, value);
    expect(selectionStats(context(doc, [1, 1], [4, 1]))).toEqual({
      count: 3,
      numbers: 2,
      sum: 30,
      average: 15,
    });
    expect(selectionStats(context(doc, [1, 1]))).toBeNull();
  });

  it("adds conditional rules after the others, reorders them, and clears them from the selection", () => {
    let doc = apply(
      emptyDoc(),
      addConditional(context(emptyDoc(), [1, 1], [3, 1]), { kind: "bar", color: "#638EC6" }),
    );
    doc = apply(
      doc,
      addConditional(context(doc, [5, 2]), { kind: "blank", style: { bold: true } }),
    );
    const [first, second] = doc.sheet.s1!.conditional!;
    expect([first!.rule.kind, second!.rule.kind]).toEqual(["bar", "blank"]);
    doc = apply(doc, editConditional(context(doc, [1, 1]), second!.id, "up"));
    expect(doc.sheet.s1!.conditional!.map((each) => each.rule.kind)).toEqual(["blank", "bar"]);
    // Cleared from A2 alone, the bar keeps A1 and A3, as Excel trims a rule's cells.
    doc = apply(doc, clearConditional(context(doc, [2, 1]), "selection"));
    expect(
      doc.sheet.s1!.conditional!.map((each) => `${each.rule.kind} ${each.box.r1}:${each.box.r2}`),
    ).toEqual(["blank s1.r5:s1.r5", "bar s1.r1:s1.r1", "bar s1.r3:s1.r3"]);
    doc = apply(doc, clearConditional(context(doc, [2, 1]), "sheet"));
    expect(doc.sheet.s1!.conditional).toBeUndefined();
  });
});
