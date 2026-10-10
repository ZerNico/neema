import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { parseFormula, renderFormula } from "./formula.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, emptySheet, liveSheets, positions, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
/** Undoes `ops` on `doc`: applies them, then their inverse. */
const roundTrip = (doc: SheetDoc, ops: readonly SheetOp[]) => {
  const after = apply(doc, ops);
  return { after, undone: apply(after, invertChange(doc, after)) };
};
/** What a person sees: every live sheet's name and its cells by position, formulas as text. */
function seen(doc: SheetDoc) {
  return liveSheets(doc).map((id) => {
    const sheet = doc.sheet[id]!;
    const rows = positions(sheet.rows).ids;
    const cols = positions(sheet.cols).ids;
    const cells: string[] = [];
    rows.forEach((r, y) =>
      cols.forEach((c, x) => {
        const cell = sheet.cells[r]?.[c];
        const shown = cell?.f ? `=${renderFormula(cell.f, { doc, sheet: id })}` : cell?.v;
        if (shown !== undefined || cell?.s)
          cells.push(`${y + 1}:${x + 1}=${String(shown)}|${cell?.s ?? ""}`);
      }),
    );
    return {
      name: sheet.name,
      rows: rows.length,
      cols: cols.length,
      cells,
      merges: sheet.merges.length,
    };
  });
}
const formula = (doc: SheetDoc, text: string) => {
  const parsed = parseFormula(text, { doc, sheet: "s1" });
  if (!("formula" in parsed)) throw new Error("needs growth");
  return parsed.formula;
};

describe("undoing a change", () => {
  it("puts back cells, styles and a deleted row with the formulas that read it", () => {
    let doc = emptyDoc();
    doc = apply(doc, [
      {
        op: "set",
        sh: "s1",
        cells: [
          { r: "s1.r1", c: "s1.c1", v: 1 },
          { r: "s1.r2", c: "s1.c1", v: 2 },
          { r: "s1.r3", c: "s1.c1", v: 3 },
          { r: "s1.r5", c: "s1.c1", f: formula(doc, "SUM(A1:A3)") },
        ],
      },
    ]);
    const { after, undone } = roundTrip(doc, [
      { op: "delete", sh: "s1", axis: "rows", ids: ["s1.r3"] },
      {
        op: "format",
        sh: "s1",
        area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
        patch: { bold: true },
      },
    ]);
    expect(seen(after)).not.toEqual(seen(doc));
    expect(seen(undone)).toEqual(seen(doc));
  });

  it("removes what it added and brings back a deleted sheet under its name", () => {
    let doc = apply(emptyDoc(), [
      { op: "sheetAdd", id: "s2", name: "Data", after: "s1", rows: ["a"], cols: ["b"] },
    ]);
    const { undone } = roundTrip(doc, [
      { op: "sheetDelete", id: "s2" },
      { op: "sheetAdd", id: "s3", name: "More", after: "s1", rows: ["x"], cols: ["y"] },
      { op: "sheetRename", id: "s1", name: "Main" },
    ]);
    expect(seen(undone)).toEqual(seen(doc));
    doc = undone;
  });

  it("leaves a cell someone else changed since", () => {
    const doc = emptyDoc();
    const mine = apply(doc, [
      { op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: "mine" }] },
    ]);
    const theirs = apply(mine, [
      { op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: "theirs" }] },
    ]);
    const undone = apply(theirs, invertChange(doc, mine, theirs));
    expect(undone.sheet.s1!.cells["s1.r1"]!["s1.c1"]!.v).toBe("theirs");
  });

  it("takes any change back to what the sheet showed before it", () => {
    const base = (): SheetDoc => ({
      ...emptyDoc(),
      sheet: { s1: emptySheet("Sheet1", "s1.", { rows: 6, cols: 3 }) },
    });
    const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
    const op = fc.oneof(
      fc
        .tuple(
          fc.integer({ min: 1, max: 6 }),
          fc.integer({ min: 1, max: 3 }),
          fc.oneof(fc.integer(), fc.string(), fc.constant(null)),
        )
        .map(([r, c, v]): SheetOp => ({
          op: "set",
          sh: "s1",
          cells: [{ r: id("r", r), c: id("c", c), v }],
        })),
      fc
        .tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 3 }), fc.boolean())
        .map(([r, c, bold]): SheetOp => ({
          op: "format",
          sh: "s1",
          area: { r1: id("r", r), r2: id("r", r), c1: id("c", c), c2: id("c", c) },
          patch: { bold: bold || null },
        })),
      fc
        .integer({ min: 1, max: 6 })
        .map((r): SheetOp => ({ op: "delete", sh: "s1", axis: "rows", ids: [id("r", r)] })),
      fc
        .tuple(fc.integer({ min: 0, max: 6 }), fc.integer({ min: 1, max: 999 }))
        .map(([after, n]): SheetOp => ({
          op: "insert",
          sh: "s1",
          axis: "rows",
          ids: [`new${n}`],
          after: after ? id("r", after) : null,
        })),
      fc.integer({ min: 1, max: 5 }).map((r): SheetOp => ({
        op: "merge",
        sh: "s1",
        box: { r1: id("r", r), r2: id("r", r + 1), c1: "s1.c1", c2: "s1.c2" },
      })),
      fc.shuffledSubarray([1, 2, 3, 4], { minLength: 4, maxLength: 4 }).map((order): SheetOp => ({
        op: "sort",
        sh: "s1",
        c1: "s1.c1",
        c2: "s1.c3",
        rows: [1, 2, 3, 4].map((n) => id("r", n)),
        order: order.map((n) => id("r", n)),
      })),
    );
    fc.assert(
      fc.property(
        fc.array(op, { maxLength: 6 }),
        fc.array(op, { minLength: 1, maxLength: 4 }),
        (setup, change) => {
          const doc = apply(base(), setup);
          expect(seen(roundTrip(doc, change).undone)).toEqual(seen(doc));
        },
      ),
      { numRuns: 300 },
    );
  });
});
