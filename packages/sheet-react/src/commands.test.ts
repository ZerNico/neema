import { describe, expect, it } from "vitest";
import { DE_DE, EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import {
  clearSelection,
  copySelection,
  deleteAtSelection,
  enterCell,
  fillSelection,
  insertAtSelection,
  parseTabular,
  pasteAtSelection,
  sortSelection,
  chartFromSelection,
  type GridContext,
} from "./commands.ts";

let minted = 0;
let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
/** A cell by A1-style row and column numbers, as IDs at current positions. */
const at = (doc: SheetDoc, row: number, col: number) => ({
  r: positions(doc.sheet.s1!.rows).ids[row - 1]!,
  c: positions(doc.sheet.s1!.cols).ids[col - 1]!,
});
const context = (
  doc: SheetDoc,
  from: [number, number],
  to: [number, number] = from,
  locale = EN_US,
): GridContext => ({
  doc,
  sheet: "s1",
  selection: { anchor: at(doc, ...from), head: at(doc, ...to) },
  values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
  locale,
  mint: () => `n${++minted}`,
});
const type = (doc: SheetDoc, row: number, col: number, raw: string, locale = EN_US) =>
  apply(doc, enterCell(context(doc, [row, col], [row, col], locale), at(doc, row, col), raw));
const shown = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }).value("s1", r, c);
};
const formulaAt = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  const f = doc.sheet.s1!.cells[r]?.[c]?.f;
  return f ? renderFormula(f, { doc, sheet: "s1" }) : undefined;
};

describe("typing into a cell", () => {
  it("reads numbers in the sheet's locale, keeping the format they were typed in", () => {
    let doc = type(emptyDoc(), 1, 1, "12,5 %", DE_DE);
    const { r, c } = at(doc, 1, 1);
    expect(doc.sheet.s1!.cells[r]![c]).toMatchObject({ v: 0.125, s: '{"numberFormat":"0.00%"}' });
    doc = type(doc, 2, 1, "'=not a formula");
    expect(shown(doc, 2, 1)).toBe("=not a formula");
  });

  it("makes a formula, growing the grid for a reference past it", () => {
    let doc = type(emptyDoc(), 1, 1, "5");
    doc = type(doc, 1, 2, "=A1*2+A1200");
    expect(positions(doc.sheet.s1!.rows).ids).toHaveLength(1200);
    expect(shown(doc, 1, 2)).toBe(10);
  });
});

describe("editing the selection", () => {
  it("inserts as many rows as are selected, and deletes them again", () => {
    let doc = type(emptyDoc(), 2, 1, "keep");
    doc = apply(doc, insertAtSelection(context(doc, [2, 1], [3, 1]), "rows", "before"));
    expect(shown(doc, 4, 1)).toBe("keep");
    doc = apply(doc, deleteAtSelection(context(doc, [2, 1], [3, 1]), "rows"));
    expect(shown(doc, 2, 1)).toBe("keep");
  });

  it("clears contents and sorts by the active column, blanks last", () => {
    let doc = emptyDoc();
    for (const [row, name, score] of [
      [1, "b", "2"],
      [2, "a", "=1+2"],
      [3, "c", ""],
      [4, "d", "1"],
    ] as const) {
      doc = type(doc, row, 1, name);
      if (score) doc = type(doc, row, 2, score);
    }
    doc = apply(doc, sortSelection(context(doc, [1, 1], [4, 2]), true));
    expect([1, 2, 3, 4].map((row) => shown(doc, row, 1))).toEqual(["a", "b", "d", "c"]);
    doc = apply(doc, clearSelection(context(doc, [1, 1], [1, 2])));
    expect([shown(doc, 1, 1), shown(doc, 1, 2)]).toEqual([null, null]);
  });

  it("fills a formula down, each copy reading its own row", () => {
    let doc = type(emptyDoc(), 1, 1, "1");
    doc = type(doc, 2, 1, "2");
    doc = type(doc, 1, 2, "=A1*10");
    doc = apply(doc, fillSelection(context(doc, [1, 2], [2, 2]), "down"));
    expect(formulaAt(doc, 2, 2)).toBe("A2*10");
    expect(shown(doc, 2, 2)).toBe(20);
  });
});

describe("the clipboard", () => {
  it("pastes its own copy with formulas shifted, and a cut as a move", () => {
    let doc = type(emptyDoc(), 1, 1, "3");
    doc = type(doc, 1, 2, "=A1+1");
    const copied = copySelection(context(doc, [1, 1], [1, 2]));
    expect(copied.text).toBe("3\t4");
    doc = apply(doc, pasteAtSelection(context(doc, [3, 1]), copied.text, copied));
    expect(formulaAt(doc, 3, 2)).toBe("A3+1");
    const cut = copySelection(context(doc, [1, 1]), true);
    doc = apply(doc, pasteAtSelection(context(doc, [5, 3]), cut.text, cut));
    expect([shown(doc, 1, 1), shown(doc, 5, 3)]).toEqual([null, 3]);
    // A formula reading the cut cell follows it.
    expect(formulaAt(doc, 1, 2)).toBe("C5+1");
  });

  it("types in text from elsewhere, quoted fields included", () => {
    expect(parseTabular('a\t"b\tc"\n"say ""hi"""\t2\n')).toEqual([
      ["a", "b\tc"],
      ['say "hi"', "2"],
    ]);
    const doc = apply(
      emptyDoc(),
      pasteAtSelection(context(emptyDoc(), [1, 1]), "x\t=1+1\n7%", null),
    );
    expect([shown(doc, 1, 1), shown(doc, 1, 2), shown(doc, 2, 1)]).toEqual(["x", 2, 0.07]);
  });
});

describe("charting the selection", () => {
  it("names series from the header row, labels points from the first column, and sits beside", () => {
    let doc = emptyDoc();
    for (const [row, cells] of [
      [1, ["Month", "Sales", "Costs"]],
      [2, ["Jan", "10", "4"]],
      [3, ["Feb", "20", "6"]],
    ] as const)
      cells.forEach((raw, index) => {
        doc = type(doc, row, index + 1, raw);
      });
    const [op] = chartFromSelection(context(doc, [1, 1], [3, 3]), "column");
    expect(op).toMatchObject({
      op: "chartPut",
      chart: {
        kind: "column",
        at: at(doc, 1, 5),
        // Names read from their header cells, so they follow edits there.
        series: [
          {
            name: { cell: { sh: "s1", r: at(doc, 1, 2).r, c: at(doc, 1, 2).c } },
            values: { r1: at(doc, 2, 1).r, r2: at(doc, 3, 1).r, c1: at(doc, 1, 2).c },
          },
          {
            name: { cell: { sh: "s1", r: at(doc, 1, 3).r, c: at(doc, 1, 3).c } },
            categories: { c1: at(doc, 1, 1).c },
          },
        ],
      },
    });
    expect(chartFromSelection(context(doc, [1, 1], [3, 3]), "pie")[0]).toMatchObject({
      chart: { series: [{ values: { c1: at(doc, 1, 2).c } }] },
    });
    expect(chartFromSelection(context(doc, [1, 1]), "line")).toEqual([]);
  });
});
