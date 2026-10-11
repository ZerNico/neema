import { describe, expect, it } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { GridContext } from "./commands.ts";
import {
  filterChoices,
  setFilterRule,
  sortFilter,
  sortSelectionBy,
  toggleFilter,
} from "./filter-commands.ts";

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
const table = [
  ["Region", "Total"],
  ["North", 120],
  ["South", 80],
  ["North", 40],
  ["East", 80],
] as const;
const doc = apply(emptyDoc(), [
  {
    op: "set",
    sh: "s1",
    cells: table.flatMap((row, y) =>
      row.map((v, x) => ({ r: `s1.r${y + 1}`, c: `s1.c${x + 1}`, v })),
    ),
  },
]);
const column = (d: SheetDoc, col: number) =>
  [1, 2, 3, 4, 5].map((row) =>
    calculateSheet(d, { revision: 1, epoch: 0, now: 45_000, seed: 1 }).value(
      "s1",
      `s1.r${row}`,
      `s1.c${col}`,
    ),
  );

describe("filter and sort commands", () => {
  it("filters the data around one cell, lists a column's values, and turns off again", () => {
    const filtered = apply(doc, toggleFilter(context(doc, [3, 2])));
    expect(filtered.sheet.s1!.filter?.box).toEqual({
      r1: "s1.r1",
      r2: "s1.r5",
      c1: "s1.c1",
      c2: "s1.c2",
    });
    expect(filterChoices(context(filtered, [1, 1]), "s1.c2")).toEqual([
      { value: "40", count: 1 },
      { value: "80", count: 2 },
      { value: "120", count: 1 },
    ]);
    const north = apply(
      filtered,
      setFilterRule(context(filtered, [1, 1]), "s1.c1", { values: ["North"] }),
    );
    // Another column lists only the rows the first lets through.
    expect(filterChoices(context(north, [1, 1]), "s1.c2").map((each) => each.value)).toEqual([
      "40",
      "120",
    ]);
    expect(apply(north, toggleFilter(context(north, [1, 1]))).sheet.s1!.filter).toBeUndefined();
  });

  it("sorts a filter's rows under its header, and a selection by several columns", () => {
    const filtered = apply(doc, toggleFilter(context(doc, [1, 1])));
    const sorted = apply(filtered, sortFilter(context(filtered, [1, 1]), "s1.c2", true));
    expect(column(sorted, 2)).toEqual(["Total", 120, 80, 80, 40]);
    const byTwo = apply(
      doc,
      sortSelectionBy(
        context(doc, [1, 1], [5, 2]),
        [
          { column: "s1.c2", descending: false },
          { column: "s1.c1", descending: true },
        ],
        true,
      ),
    );
    expect(column(byTwo, 1)).toEqual(["Region", "North", "South", "East", "North"]);
  });
});
