import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import { exportLiveSheet, importLiveSheet } from "~/modules/spreadsheets/server/adapter.ts";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { liveSheetExport } from "./export.ts";
import { sheetFromCsv, sheetFromWorkbook } from "./import.ts";

const settings = { locale: "en-US", timeZone: "UTC" };
const context = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let minted = 0;
const build = (operations: unknown[]) => {
  const doc = emptyDoc();
  const converted = convertOperations(
    { doc, seen: 0, own: new Set(), mint: () => `m.${++minted}`, context },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) throw new Error(converted.message);
  return applyChange(doc, { clientId: "m", seq: 1, ops: converted.ops }, 1).doc;
};
const at = (doc: SheetDoc, name: string, row: number, col: number) => {
  const sheet = sheetNamed(doc, name)!;
  return {
    sheet,
    r: positions(doc.sheet[sheet]!.rows).ids[row - 1]!,
    c: positions(doc.sheet[sheet]!.cols).ids[col - 1]!,
  };
};
const cellOf = (doc: SheetDoc, name: string, row: number, col: number) => {
  const { sheet, r, c } = at(doc, name, row, col);
  return doc.sheet[sheet]!.cells[r]?.[c];
};
const valueOf = (doc: SheetDoc, name: string, row: number, col: number) => {
  const { sheet, r, c } = at(doc, name, row, col);
  return calculateSheet(doc, context).value(sheet, r, c);
};

describe("importing into a live sheet", () => {
  it("brings back what an export wrote: formulas, formats, layout and names", async () => {
    const original = build([
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
          [null, null, "=SEQUENCE(2)"],
        ],
      },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:C1", bold: true, fill: "#FFEE00" },
      { kind: "setFormat", sheet: "Sheet1", range: "C2", numberFormat: "0.00" },
      { kind: "mergeCells", sheet: "Sheet1", range: "D1:E1" },
      { kind: "freezePanes", sheet: "Sheet1", cell: "A2" },
      { kind: "setColumnWidth", sheet: "Sheet1", columns: "A", width: 20 },
    ]);
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const { doc } = imported;
    expect(doc.sheets.map((each) => doc.sheet[each.id]!.name)).toEqual(["Sheet1", "Rates"]);
    const gross = cellOf(doc, "Sheet1", 2, 3)!;
    expect(renderFormula(gross.f!, { doc, sheet: "s1" })).toBe("B2*(1+Tax)");
    expect(valueOf(doc, "Sheet1", 2, 3)).toBe(12);
    expect(valueOf(doc, "Sheet1", 4, 3)).toBe(2);
    expect(JSON.parse(cellOf(doc, "Sheet1", 1, 1)!.s!)).toMatchObject({
      bold: true,
      fill: "#FFEE00",
    });
    expect(JSON.parse(gross.s!)).toEqual({ numberFormat: "0.00" });
    const sheet = doc.sheet.s1!;
    expect(sheet.merges).toHaveLength(1);
    expect(sheet.freeze).toEqual({ row: "s1.r1", col: null });
    expect(sheet.colProps["s1.c1"]?.size).toBe(20);
    expect(read.dropped).toEqual([]);
  });

  it("reads CSV in either convention, quoted fields and formulas included", () => {
    const us = sheetFromCsv(
      'Item,Amount\n"Tea, green",1234.5\nTotal,=SUM(B2:B2)\n',
      "Costs",
      settings,
    );
    if (!us.ok) throw new Error(us.reason);
    expect(valueOf(us.doc, "Costs", 2, 1)).toBe("Tea, green");
    expect(valueOf(us.doc, "Costs", 3, 2)).toBe(1234.5);
    const eu = sheetFromCsv("Artikel;Betrag\nTee;1,5\n", "Kosten", settings);
    if (!eu.ok) throw new Error(eu.reason);
    expect(valueOf(eu.doc, "Kosten", 2, 2)).toBe(1.5);
  });
});
