import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import { exportLiveSheet, inspectSpreadsheet } from "~/modules/spreadsheets/server/adapter.ts";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { liveSheetExport } from "./export.ts";
import { sheetView } from "./sheet-view.ts";

let minted = 0;
const build = (operations: unknown[], doc: SheetDoc = emptyDoc()) => {
  const converted = convertOperations(
    {
      doc,
      seen: 0,
      own: new Set(),
      mint: () => `m.${++minted}`,
      context: { revision: 1, epoch: 0, now: 45_000, seed: 1 },
    },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) throw new Error(converted.message);
  return applyChange(doc, { clientId: "m", seq: 1, ops: converted.ops }, 1).doc;
};

describe("exporting a live sheet", () => {
  it("writes a workbook whose formulas, formats and layout Excel reads back", async () => {
    const doc = build([
      { kind: "addSheet", name: "Rates" },
      { kind: "setCells", sheet: "Rates", start: "A1", rows: [[0.2]] },
      { kind: "defineName", name: "Tax", sheet: "Rates", range: "A1" },
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Item", "Net", "Gross"],
          ["Tea", 10, "=B2*(1+Tax)"],
          ["'=1+1 as text", null, "=SEQUENCE(2)"],
        ],
      },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:C1", bold: true, border: "outline" },
      { kind: "setFormat", sheet: "Sheet1", range: "C2", numberFormat: "0.00" },
      { kind: "mergeCells", sheet: "Sheet1", range: "D1:E1" },
      { kind: "freezePanes", sheet: "Sheet1", cell: "A2" },
      { kind: "setColumnWidth", sheet: "Sheet1", columns: "A", width: 20 },
    ]);
    const bytes = await exportLiveSheet(liveSheetExport(doc));
    const read = await inspectSpreadsheet(bytes, { sheet: "Sheet1" });
    expect(read.sheets.map((sheet) => sheet.name)).toEqual(["Sheet1", "Rates"]);
    expect(read.sheets[0]).toMatchObject({ frozenAt: "A2", merged: ["D1:E1"] });
    expect(read.names).toEqual([expect.objectContaining({ name: "Tax" })]);
    const cells = Object.fromEntries(read.window!.cells.map((cell) => [cell.cell, cell]));
    expect(cells.C2).toMatchObject({ value: "12.00", formula: "=B2*(1+Tax)", format: "0.00" });
    // A typed "=" stays text; a dynamic array spills in the file as in the live sheet.
    expect(cells.A3).toMatchObject({ value: "=1+1 as text" });
    expect([cells.C3?.value, cells.C4?.value]).toEqual(["1", "2"]);
  });

  it("draws a chart from another sheet's cells in the view and the file", async () => {
    const doc = build([
      { kind: "addSheet", name: "Data" },
      {
        kind: "setCells",
        sheet: "Data",
        start: "A1",
        rows: [
          ["Jan", 10],
          ["Feb", 20],
        ],
      },
      {
        kind: "addChart",
        sheet: "Sheet1",
        type: "column",
        at: "B2",
        title: "Sales",
        categories: "Data!A1:A2",
        series: [{ values: "Data!B1:B2", name: "Sales" }],
      },
    ]);
    const view = sheetView(
      doc,
      calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
    );
    expect(view.xml).toMatch(
      /<chart id="[^"]+" sheet="Sheet1" type="column" at="B2" title="Sales" categories="Data!A1:A2" series="Data!B1:B2 \(Sales\)"\/>/,
    );
    const read = await inspectSpreadsheet(await exportLiveSheet(liveSheetExport(doc)));
    expect(read.sheets.find((sheet) => sheet.name === "Sheet1")?.charts).toBe(1);
  });
});
