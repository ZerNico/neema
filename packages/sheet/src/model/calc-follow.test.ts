import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { calculateSheet, type CalcContext, type SheetValues } from "./calc.ts";
import { parseFormula } from "./formula.ts";
import { emptyDoc, positions, type SheetDoc } from "./model.ts";
import type { CellWrite, SheetOp } from "./ops.ts";

const SIZE = 7;
const context: CalcContext = { revision: 1, epoch: 0, now: 45_000, seed: 1 };

/** Formulas that read cells, ranges, whole columns, spills, other formulas and cycles. */
const FORMULAS = [
  "A1+B1",
  "SUM(A1:A7)",
  "SUM(B:B)",
  "SEQUENCE(A1)",
  "SUM(D1#)",
  'INDIRECT("B"&A2)',
  "B2*2",
  "VLOOKUP(A1,A1:B7,2,FALSE)",
  'IF(A3>2,B3,"low")',
  "COUNT(A1:G7)",
  "C5+1",
  "C4+1",
  "MAX(E1:E7)",
  "RAND()",
  'TEXTJOIN(",",TRUE,A1:A4)',
];

type Write =
  | { k: "value"; row: number; col: number; v: number | string | null }
  | { k: "formula"; row: number; col: number; f: number }
  | { k: "bold"; row: number; col: number }
  | { k: "insert"; row: number };

const write = fc.oneof(
  fc.record({
    k: fc.constant("value" as const),
    row: fc.nat(SIZE - 1),
    col: fc.nat(SIZE - 1),
    v: fc.oneof(fc.integer({ min: -2, max: 6 }), fc.constantFrom("x", "3"), fc.constant(null)),
  }),
  fc.record({
    k: fc.constant("formula" as const),
    row: fc.nat(SIZE - 1),
    col: fc.nat(SIZE - 1),
    f: fc.nat(FORMULAS.length - 1),
  }),
  fc.record({ k: fc.constant("bold" as const), row: fc.nat(SIZE - 1), col: fc.nat(SIZE - 1) }),
  // A new row moves every position below it, so the next calculation starts over.
  fc.record({ k: fc.constant("insert" as const), row: fc.nat(SIZE - 1) }),
);
let minted = 0;

const opOf = (doc: SheetDoc, each: Write): SheetOp => {
  const [rows, cols] = [positions(doc.sheet.s1!.rows), positions(doc.sheet.s1!.cols)];
  if (each.k === "insert")
    return {
      op: "insert",
      sh: "s1",
      axis: "rows",
      ids: [`n${++minted}`],
      after: rows.ids[each.row]!,
    };
  const at = { r: rows.ids[each.row]!, c: cols.ids[each.col]! };
  if (each.k === "bold")
    return {
      op: "format",
      sh: "s1",
      area: { r1: at.r, r2: at.r, c1: at.c, c2: at.c },
      patch: { bold: true },
    };
  if (each.k === "value") return { op: "set", sh: "s1", cells: [{ ...at, v: each.v }] };
  const parsed = parseFormula(FORMULAS[each.f]!, { doc, sheet: "s1" });
  if (!("formula" in parsed)) throw new Error(`unparsed ${FORMULAS[each.f]}`);
  return { op: "set", sh: "s1", cells: [{ ...at, f: parsed.formula } satisfies CellWrite] };
};

/** Every cell's value and spill, and the report, as one comparable record. */
const snapshot = (doc: SheetDoc, values: SheetValues) => {
  const [rows, cols] = [positions(doc.sheet.s1!.rows), positions(doc.sheet.s1!.cols)];
  const cells: unknown[] = [];
  for (const r of rows.ids.slice(0, SIZE + 2))
    for (const c of cols.ids.slice(0, SIZE + 2))
      cells.push([values.value("s1", r, c), values.spill("s1", r, c)]);
  return { cells, report: values.report, volatile: values.volatile };
};

describe("a calculation following the one before", () => {
  it("gives what calculating the whole document gives, edit after edit", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(write, { minLength: 1, maxLength: 3 }), { maxLength: 12 }),
        (edits) => {
          let doc = emptyDoc();
          let previous = calculateSheet(doc, context, undefined, { previous: null });
          edits.forEach((batch, index) => {
            doc = applyChange(
              doc,
              { clientId: "t", seq: index + 1, ops: batch.map((each) => opOf(doc, each)) },
              index + 2,
            ).doc;
            // Every other step brings a new moment, as a confirmed revision does.
            const at =
              index % 2
                ? { ...context, revision: index + 2, now: 45_000 + index, seed: index }
                : context;
            const followed = calculateSheet(doc, at, undefined, { previous });
            expect(snapshot(doc, followed)).toEqual(snapshot(doc, calculateSheet(doc, at)));
            previous = followed;
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keeps reused NOW and RAND volatile, refreshes their dependents, and retires the last reader", () => {
    let doc = emptyDoc();
    const writeFormula = (r: string, c: string, text: string): CellWrite => {
      const parsed = parseFormula(text, { doc, sheet: "s1" });
      if (!("formula" in parsed)) throw new Error("unparsed");
      return { r, c, f: parsed.formula };
    };
    const edit = (...cells: CellWrite[]) => {
      doc = applyChange(
        doc,
        { clientId: "t", seq: 1, ops: [{ op: "set", sh: "s1", cells }] },
        2,
      ).doc;
    };
    edit(
      writeFormula("s1.r1", "s1.c1", "NOW()"),
      writeFormula("s1.r2", "s1.c1", "RAND()"),
      writeFormula("s1.r1", "s1.c2", "A1+A2"),
    );
    let previous = calculateSheet(doc, context, undefined, { previous: null });
    expect(previous.volatile).toBe(true);
    edit({ r: "s1.r4", c: "s1.c4", v: "unrelated" });
    previous = calculateSheet(doc, context, undefined, { previous });
    expect(snapshot(doc, previous)).toEqual(snapshot(doc, calculateSheet(doc, context)));
    expect(previous.volatile).toBe(true);
    const next = { ...context, revision: 3, now: context.now + 1, seed: 8 };
    previous = calculateSheet(doc, next, undefined, { previous });
    expect(snapshot(doc, previous)).toEqual(snapshot(doc, calculateSheet(doc, next)));
    expect(previous.value("s1", "s1.r1", "s1.c1")).toBe(next.now);
    expect(previous.value("s1", "s1.r1", "s1.c2")).toBe(
      next.now + Number(previous.value("s1", "s1.r2", "s1.c1")),
    );
    edit({ r: "s1.r1", c: "s1.c1", v: 10 });
    previous = calculateSheet(doc, next, undefined, { previous });
    expect(previous.volatile).toBe(true);
    edit({ r: "s1.r2", c: "s1.c1", v: 20 });
    previous = calculateSheet(doc, next, undefined, { previous });
    expect(previous.volatile).toBe(false);
    expect(snapshot(doc, previous)).toEqual(snapshot(doc, calculateSheet(doc, next)));
    const later = { ...next, now: next.now + 1, seed: 9 };
    const followed = calculateSheet(doc, later, undefined, { previous });
    expect(snapshot(doc, followed)).toEqual(snapshot(doc, calculateSheet(doc, later)));
    expect(followed.value("s1", "s1.r1", "s1.c2")).toBe(30);
  });

  it("drops volatility when a changed dependency makes a volatile branch stop reading context", () => {
    let doc = emptyDoc();
    const parsed = parseFormula("IF(A1,NOW(),0)", { doc, sheet: "s1" });
    if (!("formula" in parsed)) throw new Error("unparsed");
    doc = applyChange(
      doc,
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: true },
              { r: "s1.r1", c: "s1.c2", f: parsed.formula },
            ],
          },
        ],
      },
      1,
    ).doc;
    const first = calculateSheet(doc, context, undefined, { previous: null });
    expect(first.volatile).toBe(true);
    doc = applyChange(
      doc,
      {
        clientId: "t",
        seq: 2,
        ops: [{ op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", v: false }] }],
      },
      2,
    ).doc;
    const next = calculateSheet(doc, context, undefined, { previous: first });
    expect(next.volatile).toBe(false);
    expect(snapshot(doc, next)).toEqual(snapshot(doc, calculateSheet(doc, context)));
  });

  it("follows one edit down a long column", () => {
    let doc = emptyDoc();
    const cells: CellWrite[] = [];
    const rows = positions(doc.sheet.s1!.rows).ids;
    const [a, b] = positions(doc.sheet.s1!.cols).ids as [string, string];
    for (let row = 0; row < 200; row++) {
      cells.push({ r: rows[row]!, c: a, v: row });
      const parsed = parseFormula(`A${row + 1}*2`, { doc, sheet: "s1" });
      if ("formula" in parsed) cells.push({ r: rows[row]!, c: b, f: parsed.formula });
    }
    doc = applyChange(doc, { clientId: "t", seq: 1, ops: [{ op: "set", sh: "s1", cells }] }, 2).doc;
    const first = calculateSheet(doc, context, undefined, { previous: null });
    const edited = applyChange(
      doc,
      {
        clientId: "t",
        seq: 2,
        ops: [{ op: "set", sh: "s1", cells: [{ r: rows[5]!, c: a, v: 100 }] }],
      },
      3,
    ).doc;
    const followed = calculateSheet(edited, context, undefined, { previous: first });
    expect(followed.value("s1", rows[5]!, b)).toBe(200);
    expect(followed.value("s1", rows[6]!, b)).toBe(12);
  });
});
