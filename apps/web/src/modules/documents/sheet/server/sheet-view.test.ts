import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { sheetView } from "./sheet-view.ts";

const context: CalcContext = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let minted = 0;
const build = (operations: unknown[], doc: SheetDoc = emptyDoc()) => {
  const converted = convertOperations(
    { doc, seen: 0, own: new Set(), mint: () => `m.${++minted}`, context },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) throw new Error(converted.message);
  return applyChange(doc, { clientId: "m", seq: 1, ops: converted.ops }, 1).doc;
};
const view = (doc: SheetDoc, window = {}, budget?: number) =>
  sheetView(doc, calculateSheet(doc, context), window, budget);

describe("the model's view of a sheet", () => {
  it("shows rows that hold anything, formulas beside their values, and formats", () => {
    const doc = build([
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Item", "Price"],
          ["Tea", 3.5],
        ],
      },
      { kind: "setCells", sheet: "Sheet1", start: "A4", rows: [["Total", "=SUM(B2:B3)"]] },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:B1", bold: true },
      { kind: "setFormat", sheet: "Sheet1", range: "B2:B4", numberFormat: "$#,##0.00" },
      { kind: "mergeCells", sheet: "Sheet1", range: "C1:D1" },
      { kind: "freezePanes", sheet: "Sheet1", cell: "A2" },
    ]);
    expect(view(doc).xml).toBe(
      [
        '<tabs locale="en-US">',
        '<tab name="Sheet1" used="A1:B4" frozen="A2" shown/>',
        "</tabs>",
        '<cells sheet="Sheet1" range="A1:B4">',
        '1| A1 "Item" | B1 "Price"',
        '2| A2 "Tea" | B2 3.5 ("$3.50")',
        '4| A4 "Total" | B4 =SUM(B2:B3) → 3.5 ("$3.50")',
        "</cells>",
        "<formats>",
        "A1:B1 bold",
        'B2:B4 numberFormat="$#,##0.00"',
        "</formats>",
        "<merges>C1:D1</merges>",
      ].join("\n"),
    );
  });

  it("cuts a long sheet into windows that say where to go on", () => {
    const doc = build([
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: Array.from({ length: 50 }, (_, index) => [`row ${index + 1}`]),
      },
    ]);
    const first = view(doc, {}, 400);
    expect(first.next).toEqual({ sheet: "Sheet1", range: expect.stringMatching(/^A\d+:A50$/) });
    const second = view(doc, first.next!, 400);
    expect(second.xml).toContain(`${first.next!.range!.match(/\d+/)![0]}| A`);
  });
});
