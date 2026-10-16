import { XError } from "@chat/sheet/engine/values";
import { cellStyle } from "@chat/sheet/style";
import { describe, expect, it } from "vitest";
import type { SpreadsheetPreview } from "~/modules/spreadsheets/preview.ts";
import { previewSheet } from "./spreadsheet-preview-sheet.ts";

const preview = (over: Partial<SpreadsheetPreview> = {}): SpreadsheetPreview => ({
  sheets: [{ name: "Sales" }],
  sheet: "Sales",
  rows: 3,
  cols: 2,
  cells: [
    { row: 1, col: 1, value: "Month", style: 0 },
    { row: 2, col: 2, value: 12, formula: "=A2*3" },
    { row: 3, col: 2, value: { error: "#DIV/0!" }, formula: "=1/0" },
  ],
  styles: [{ bold: true, fill: "#FFFF00" }],
  widths: [[1, 20]],
  heights: [[1, 30]],
  merges: ["A1:B1", "A3:XFD1048576"],
  freeze: "B2",
  hiddenRows: [2],
  hiddenCols: [],
  conditional: [],
  charts: [],
  otherCharts: 0,
  images: [],
  truncated: false,
  ...over,
});

describe("a sheet preview in the grid", () => {
  it("holds the stored values and styles, with formulas only for the bar", () => {
    const { sheet, value, formula } = previewSheet(preview());
    expect(value("r2", "c2")).toBe(12);
    expect(value("r3", "c2")).toEqual(new XError("#DIV/0!"));
    expect(formula("r2", "c2")).toBe("=A2*3");
    expect(cellStyle(sheet.cells.r1!.c1!.s)).toEqual({ bold: true, fill: "#FFFF00" });
    expect(sheet.colProps.c1).toEqual({ size: 20 });
    expect(sheet.rowProps).toMatchObject({ r1: { size: 30 }, r2: { hidden: true } });
    expect(sheet.freeze).toEqual({ row: "r1", col: "c1" });
  });

  it("draws past the last cell, and as far as a merge reaches, within a bound", () => {
    const plain = previewSheet(preview({ merges: ["A1:B1"] })).sheet;
    expect([plain.rows.length, plain.cols.length]).toEqual([100, 26]);
    // A title merged across 52 columns keeps its span.
    const wide = previewSheet(preview({ merges: ["A1:AZ1"] })).sheet;
    expect(wide.cols.length).toBe(57);
    expect(wide.merges).toEqual([{ r1: "r1", c1: "c1", r2: "r1", c2: "c52" }]);
    // One over the whole sheet widens it only so far, and is clipped to what is drawn.
    const whole = previewSheet(preview()).sheet;
    expect([whole.rows.length, whole.cols.length]).toEqual([10_030, 707]);
    expect(whole.merges[1]).toEqual({ r1: "r3", c1: "c1", r2: "r10030", c2: "c707" });
  });

  it("reaches as far as its drawings, and stops where a cut-off sheet was cut", () => {
    const chart = { index: 0, row: 140, col: 30, x: 0, y: 0, width: 400, height: 300 };
    const reached = previewSheet(preview({ charts: [chart] }));
    expect(reached.cellAt(140, 30)).toEqual({ r: "r140", c: "c30" });
    const cut = previewSheet(preview({ truncated: true }));
    expect(cut.sheet.rows).toHaveLength(3);
    expect(cut.cellAt(4, 1)).toBeNull();
  });
});
