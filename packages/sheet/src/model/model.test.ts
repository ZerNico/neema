import { describe, expect, it } from "vitest";
import { parseCell } from "../a1.ts";
import { applyChange } from "./apply.ts";
import { copyFormula, parseFormula, renderFormula } from "./formula.ts";
import { emptyDoc, emptySheet, positions, type Formula, type SheetDoc } from "./model.ts";
import { parseChange, type SheetOp } from "./ops.ts";

let seq = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++seq, ops }, seq);
const rowId = (doc: SheetDoc, row: number, sheet = "s1") =>
  positions(doc.sheet[sheet]!.rows).ids[row - 1]!;
const colId = (doc: SheetDoc, col: number, sheet = "s1") =>
  positions(doc.sheet[sheet]!.cols).ids[col - 1]!;
const formula = (doc: SheetDoc, text: string, sheet = "s1"): Formula => {
  const parsed = parseFormula(text, { doc, sheet });
  if (!("formula" in parsed)) throw new Error("needs growth");
  return parsed.formula;
};
const render = (doc: SheetDoc, f: Formula, sheet = "s1") => renderFormula(f, { doc, sheet });
/** The cell at an A1 address, by current positions. */
const cell = (doc: SheetDoc, address: string, sheet = "s1") => {
  const { row, column } = parseCell(address)!;
  return doc.sheet[sheet]!.cells[rowId(doc, row, sheet)]?.[colId(doc, column, sheet)];
};
const set = (
  doc: SheetDoc,
  address: string,
  content: { v?: string | number; f?: string },
  sheet = "s1",
) => {
  const { row, column } = parseCell(address)!;
  return apply(doc, {
    op: "set",
    sh: sheet,
    cells: [
      {
        r: rowId(doc, row, sheet),
        c: colId(doc, column, sheet),
        ...(content.f ? { f: formula(doc, content.f, sheet) } : { v: content.v ?? null }),
      },
    ],
  }).doc;
};
const insertRows = (doc: SheetDoc, afterRow: number | null, ids: string[]) =>
  apply(doc, {
    op: "insert",
    sh: "s1",
    axis: "rows",
    ids,
    after: afterRow === null ? null : rowId(doc, afterRow),
  }).doc;
const deleteRows = (doc: SheetDoc, ...rows: number[]) =>
  apply(doc, { op: "delete", sh: "s1", axis: "rows", ids: rows.map((row) => rowId(doc, row)) }).doc;

describe("formulas held by IDs", () => {
  it("writes back exactly what was typed, $ marks, whole columns and other sheets included", () => {
    const doc = apply(emptyDoc(), {
      op: "sheetAdd",
      id: "s2",
      name: "Q3 data",
      after: "s1",
      rows: emptySheet("", "s2.").rows.map((row) => row.id),
      cols: emptySheet("", "s2.").cols.map((col) => col.id),
    }).doc;
    for (const text of [
      "SUM($A$1:B2)*2",
      "'Q3 data'!C:C+A$5",
      "COUNT(3:4)",
      'IF(A1>0,"A1",B2)',
      "A2:A1048576",
    ])
      expect(render(doc, formula(doc, text))).toBe(text);
  });

  it("follows inserted rows as Excel does: a range grows only when rows go inside it", () => {
    let doc = emptyDoc();
    const f = formula(doc, "SUM(A2:A4)+B1");
    doc = insertRows(doc, null, ["n1"]);
    expect(render(doc, f)).toBe("SUM(A3:A5)+B2");
    doc = insertRows(doc, 3, ["n2"]);
    expect(render(doc, f)).toBe("SUM(A3:A6)+B2");
    doc = insertRows(doc, 6, ["n3"]);
    expect(render(doc, f)).toBe("SUM(A3:A6)+B2");
  });

  it("moves a deleted endpoint inward, and gives #REF! where nothing is left", () => {
    let doc = set(emptyDoc(), "D1", { f: "SUM(A2:A4)+B3" });
    const stored = () => render(doc, cell(doc, "D1")!.f!);
    // Row 3 holds B3 and sits inside the range, which shrinks round it.
    doc = deleteRows(doc, 3);
    expect(stored()).toBe("SUM(A2:A3)+#REF!");
    // Row 2 is the range's first corner: it moves inward to what was row 4.
    doc = deleteRows(doc, 2);
    expect(stored()).toBe("SUM(A2:A2)+#REF!");
    doc = deleteRows(doc, 2);
    expect(stored()).toBe("SUM(#REF!)+#REF!");
    // Deleting is a mark: reviving the rows brings a single cell's reference
    // back. The range's first corner moved when its row went, so it stays
    // there; restoring it is undo's, which carries the formula as it was.
    doc = apply(doc, {
      op: "revive",
      sh: "s1",
      axis: "rows",
      ids: ["s1.r2", "s1.r3", "s1.r4"],
    }).doc;
    expect(stored()).toBe("SUM(A4:A4)+B3");
  });

  it("does not let a row inserted beside a deleted endpoint into the range", () => {
    let doc = set(emptyDoc(), "D1", { f: "SUM(A1:A3)" });
    const stored = () => render(doc, cell(doc, "D1")!.f!);
    doc = deleteRows(doc, 3);
    expect(stored()).toBe("SUM(A1:A2)");
    doc = insertRows(doc, 2, ["n1"]);
    expect(stored()).toBe("SUM(A1:A2)");
  });

  it("renders a renamed sheet's new name and #REF! for a deleted one", () => {
    let doc = apply(emptyDoc(), {
      op: "sheetAdd",
      id: "s2",
      name: "Data",
      after: "s1",
      rows: ["x1", "x2"],
      cols: ["y1"],
    }).doc;
    const f = formula(doc, "Data!A2*2");
    doc = apply(doc, { op: "sheetRename", id: "s2", name: "Sales data" }).doc;
    expect(render(doc, f)).toBe("'Sales data'!A2*2");
    doc = apply(doc, { op: "sheetDelete", id: "s2" }).doc;
    expect(render(doc, f)).toBe("#REF!*2");
  });

  it("asks for the grid to grow before holding a reference past it", () => {
    const doc = emptyDoc();
    expect(parseFormula("A1001+AA1", { doc, sheet: "s1" })).toEqual({
      grow: [{ sheet: "s1", rows: 1001, cols: 27 }],
    });
  });

  it("copies relative parts and keeps absolute ones; off the grid is #REF!", () => {
    const doc = emptyDoc();
    const f = formula(doc, "$A1+B$2+C:C+SUM(A1:B2)");
    const copied = copyFormula(f, { rows: 2, cols: 1 }, { doc, sheet: "s1" });
    expect("formula" in copied && render(doc, copied.formula)).toBe("$A3+C$2+D:D+SUM(B3:C4)");
    const up = copyFormula(formula(doc, "A1+$B$1"), { rows: -1, cols: 0 }, { doc, sheet: "s1" });
    expect("formula" in up && render(doc, up.formula)).toBe("#REF!+$B$1");
  });
});

describe("applying changes", () => {
  it("records who wrote last: a clear is a write and keeps the cell's format", () => {
    let doc = set(emptyDoc(), "A1", { v: 5 });
    const written = cell(doc, "A1")!.w;
    doc = apply(doc, {
      op: "format",
      sh: "s1",
      area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
      patch: { bold: true },
    }).doc;
    expect(cell(doc, "A1")).toMatchObject({ v: 5, w: written, s: '{"bold":true}' });
    doc = apply(doc, {
      op: "clear",
      sh: "s1",
      area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
      what: "contents",
    }).doc;
    expect(cell(doc, "A1")).toEqual({ w: seq, s: '{"bold":true}', wf: seq - 1 });
  });

  it("inserts after a deleted row in its place, not at the end", () => {
    let doc = deleteRows(emptyDoc(), 3);
    doc = apply(doc, { op: "insert", sh: "s1", axis: "rows", ids: ["n1"], after: "s1.r3" }).doc;
    expect(positions(doc.sheet.s1!.rows).at("n1")).toBe(3);
  });

  it("moves cut cells and every reference wholly inside them", () => {
    let doc = set(emptyDoc(), "A1", { v: 7 });
    doc = set(doc, "C1", { f: "A1*2+SUM(A1:A2)" });
    doc = apply(doc, {
      op: "move",
      sh: "s1",
      box: { r1: "s1.r1", r2: "s1.r2", c1: "s1.c1", c2: "s1.c1" },
      to: { r: "s1.r5", c: "s1.c2" },
    }).doc;
    expect(cell(doc, "B5")).toMatchObject({ v: 7 });
    expect(cell(doc, "A1")?.v).toBeUndefined();
    expect(render(doc, cell(doc, "C1")!.f!)).toBe("B5*2+SUM(B5:B6)");
  });

  it("sorts by the order it carries, moving formulas as a copy would", () => {
    let doc = set(emptyDoc(), "A1", { v: 30 });
    doc = set(doc, "A2", { v: 10 });
    doc = set(doc, "B1", { f: "A1*2" });
    doc = set(doc, "B2", { f: "A2*2" });
    doc = set(doc, "C5", { f: "B1+B2" });
    doc = apply(doc, {
      op: "sort",
      sh: "s1",
      c1: "s1.c1",
      c2: "s1.c2",
      rows: ["s1.r1", "s1.r2"],
      order: ["s1.r2", "s1.r1"],
    }).doc;
    expect([cell(doc, "A1")?.v, cell(doc, "A2")?.v]).toEqual([10, 30]);
    // Each moved formula still reads its own row; a reference from outside keeps its place.
    expect(render(doc, cell(doc, "B1")!.f!)).toBe("A1*2");
    expect(render(doc, cell(doc, "B2")!.f!)).toBe("A2*2");
    expect(render(doc, cell(doc, "C5")!.f!)).toBe("B1+B2");
  });

  it("drops what can't apply and says so, applying the rest", () => {
    let doc = apply(emptyDoc(), {
      op: "merge",
      sh: "s1",
      box: { r1: "s1.r1", r2: "s1.r2", c1: "s1.c1", c2: "s1.c2" },
    }).doc;
    const result = apply(
      doc,
      { op: "merge", sh: "s1", box: { r1: "s1.r2", r2: "s1.r3", c1: "s1.c2", c2: "s1.c3" } },
      { op: "sheetDelete", id: "s1" },
      {
        op: "set",
        sh: "s1",
        cells: [
          { r: "nope", c: "s1.c1", v: 1 },
          { r: "s1.r9", c: "s1.c1", v: 2 },
        ],
      },
    );
    doc = result.doc;
    expect(result.dropped).toEqual([
      "a merge over another merge",
      "the last sheet",
      "a cell whose row or column was deleted",
    ]);
    expect(cell(doc, "A9")?.v).toBe(2);
    expect(doc.sheet.s1!.merges).toHaveLength(1);
  });

  it("changes the locale and time zone one at a time", () => {
    let doc = apply(emptyDoc(), { op: "settings", locale: "de-DE" }).doc;
    doc = apply(doc, { op: "settings", timeZone: "Europe/Berlin" }).doc;
    expect(doc.settings).toEqual({ locale: "de-DE", timeZone: "Europe/Berlin" });
  });

  it("gives a sheet named like another a name of its own", () => {
    const doc = apply(emptyDoc(), {
      op: "sheetAdd",
      id: "s2",
      name: "sheet1",
      after: "s1",
      rows: ["a"],
      cols: ["b"],
    }).doc;
    expect(doc.sheet.s2!.name).toBe("sheet1 (2)");
  });
});

describe("changes from the wire", () => {
  it("accepts a well-formed change and names what is wrong with one that is not", () => {
    const change = {
      clientId: "a",
      seq: 1,
      ops: [{ op: "set", sh: "s1", cells: [{ r: "x", c: "y", v: 1 }] }],
    };
    expect(parseChange(change)).toEqual({ ok: true, change });
    expect(parseChange({ clientId: "a", seq: 1, ops: [{ op: "explode" }] })).toEqual({
      ok: false,
      error: "op 0 is not an operation",
    });
    expect(
      parseChange({
        clientId: "a",
        seq: 1,
        ops: [{ op: "set", sh: "s1", cells: [{ r: "x", c: "y", v: {} }] }],
      }),
    ).toEqual({
      ok: false,
      error: "op 0 (set) is malformed",
    });
    expect(parseChange({ seq: 1, ops: [] })).toMatchObject({ ok: false });
  });
});
