import { describe, expect, it } from "vitest";
import { parseCell } from "../a1.ts";
import { XError } from "../engine/evaluate.ts";
import { applyChange } from "./apply.ts";
import { calculateSheet, type CalcContext } from "./calc.ts";
import { parseFormula } from "./formula.ts";
import { emptyDoc, positions, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

const context: CalcContext = { revision: 1, epoch: 0, now: 45292.75, seed: 7 };
let seq = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++seq, ops }, seq).doc;
const at = (doc: SheetDoc, address: string, sheet = "s1") => {
  const { row, column } = parseCell(address)!;
  return {
    r: positions(doc.sheet[sheet]!.rows).ids[row - 1]!,
    c: positions(doc.sheet[sheet]!.cols).ids[column - 1]!,
  };
};
/** Types each entry in: "=" makes a formula, anything else a value. */
const typed = (doc: SheetDoc, entries: Record<string, string | number>, sheet = "s1") =>
  apply(doc, {
    op: "set",
    sh: sheet,
    cells: Object.entries(entries).map(([address, entry]) => {
      const { r, c } = at(doc, address, sheet);
      if (typeof entry === "string" && entry.startsWith("=")) {
        const parsed = parseFormula(entry.slice(1), { doc, sheet });
        if (!("formula" in parsed)) throw new Error("needs growth");
        return { r, c, f: parsed.formula };
      }
      return { r, c, v: entry };
    }),
  });
const valueAt = (doc: SheetDoc, address: string, given = context, sheet = "s1") => {
  const { r, c } = at(doc, address, sheet);
  return calculateSheet(doc, given).value(sheet, r, c);
};

describe("calculating a live sheet", () => {
  it("calculates across sheets and names, and keeps results through an insert", () => {
    let doc = apply(emptyDoc(), {
      op: "sheetAdd",
      id: "s2",
      name: "Rates",
      after: "s1",
      rows: ["q1", "q2"],
      cols: ["k1"],
    });
    doc = typed(doc, { A1: 0.2 }, "s2");
    doc = apply(doc, {
      op: "name",
      name: "Tax",
      f: (parseFormula("Rates!$A$1", { doc, sheet: "s1" }) as { formula: never }).formula,
    });
    doc = typed(doc, { A1: 100, A2: "=A1*(1+Tax)", A3: "=SUM(A1:A2)" });
    expect(valueAt(doc, "A3")).toBe(220);
    doc = apply(doc, { op: "insert", sh: "s1", axis: "rows", ids: ["n1"], after: null });
    expect(valueAt(doc, "A4")).toBe(220);
    doc = apply(doc, { op: "delete", sh: "s1", axis: "rows", ids: [at(doc, "A2").r] });
    expect(valueAt(doc, "A2")).toEqual(new XError("#REF!"));
  });

  it("spills a dynamic formula beside itself, blocked by a typed value", () => {
    let doc = typed(emptyDoc(), { A1: "=SEQUENCE(3)", A3: "in the way" });
    expect(valueAt(doc, "A1")).toEqual(new XError("#SPILL!"));
    expect(valueAt(doc, "A3")).toBe("in the way");
    doc = apply(doc, { op: "set", sh: "s1", cells: [{ ...at(doc, "A3"), v: null }] });
    const values = calculateSheet(doc, context);
    expect(
      [1, 2, 3].map((row) => values.value("s1", at(doc, `A${row}`).r, at(doc, "A1").c)),
    ).toEqual([1, 2, 3]);
    expect(values.spill("s1", at(doc, "A1").r, at(doc, "A1").c)?.rows).toHaveLength(3);
  });

  it("does not cut a spill short at the grid's last row: it is #SPILL! until the grid grows", () => {
    const doc = typed(emptyDoc(), { A999: "=SEQUENCE(3)" });
    expect(valueAt(doc, "A999")).toEqual(new XError("#SPILL!"));
    const grown = apply(doc, {
      op: "insert",
      sh: "s1",
      axis: "rows",
      ids: ["g1"],
      after: "s1.r1000",
    });
    expect(valueAt(grown, "A1001")).toBe(3);
  });

  it("groups and pivots rows with GROUPBY and PIVOTBY, as Excel's pivot formulas", () => {
    const data = {
      A1: "Region",
      B1: "Product",
      C1: "Sales",
      A2: "North",
      B2: "Tea",
      C2: 10,
      A3: "south",
      B3: "Tea",
      C3: 5,
      A4: "North",
      B4: "Coffee",
      C4: 20,
      A5: "South",
      B5: "Coffee",
      C5: 7,
      A6: "North",
      B6: "Tea",
      C6: 1,
    };
    const doc = typed(emptyDoc(), {
      ...data,
      E1: "=GROUPBY(A1:A6, C1:C6, SUM)",
      E10: "=PIVOTBY(A2:A6, B2:B6, C2:C6, SUM, 0, 1, -2)",
      E20: "=GROUPBY(A2:A6, C2:C6, PERCENTOF, 0, 0)",
    });
    const values = calculateSheet(doc, context);
    const read = (top: number, left: string, rows: number, cols: number) =>
      Array.from({ length: rows }, (_row, y) =>
        Array.from({ length: cols }, (_column, x) => {
          const address = `${String.fromCharCode(left.charCodeAt(0) + x)}${top + y}`;
          return values.value("s1", at(doc, address).r, at(doc, address).c);
        }),
      );
    // Headers guessed from text above numbers; text grouped without case; a grand total below.
    expect(read(1, "E", 4, 2)).toEqual([
      ["Region", "Sales"],
      ["North", 31],
      ["south", 12],
      ["Total", 43],
    ]);
    // Rows sorted by the result's second column (Coffee), descending; totals both ways.
    expect(read(10, "E", 4, 4)).toEqual([
      [null, "Coffee", "Tea", "Total"],
      ["North", 20, 11, 31],
      ["south", 7, 5, 12],
      ["Total", 27, 16, 43],
    ]);
    expect(read(20, "E", 2, 2)).toEqual([
      ["North", 31 / 43],
      ["south", 12 / 43],
    ]);
  });

  it("takes time and chance from the context, so every replica agrees", () => {
    const doc = typed(emptyDoc(), {
      A1: "=NOW()",
      A2: "=TODAY()",
      A3: "=RAND()",
      A4: "=RAND()-RAND()",
      A5: "=RANDBETWEEN(1,6)",
      B1: "=RANDARRAY(2,2,1,9,TRUE)",
    });
    expect(valueAt(doc, "A1")).toBe(45292.75);
    expect(valueAt(doc, "A2")).toBe(45292);
    const first = valueAt(doc, "A3");
    expect(typeof first).toBe("number");
    expect(valueAt(doc, "A3")).toBe(first);
    expect(valueAt(doc, "A3", { ...context, seed: 8 })).not.toBe(first);
    // Two calls in one formula draw from streams of their own.
    expect(valueAt(doc, "A4")).not.toBe(0);
    expect(valueAt(doc, "A5")).toBeGreaterThanOrEqual(1);
    expect(valueAt(doc, "A5")).toBeLessThanOrEqual(6);
    const grid = ["B1", "C1", "B2", "C2"].map((address) => valueAt(doc, address));
    expect(
      grid.every(
        (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 9,
      ),
    ).toBe(true);
  });

  it("shows #NAME? for a formula the engine cannot read", () => {
    const doc = typed(emptyDoc(), { A1: "=NOSUCHFUNCTION(1)" });
    expect(valueAt(doc, "A1")).toEqual(new XError("#NAME?"));
  });
});
