import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { calculateSheet } from "./calc.ts";
import { filteredRows, isSheetFilter, type SheetFilter } from "./filter.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
const rows: Array<[string, number | string]> = [
  ["Region", "Total"],
  ["North", 120],
  ["South", 80],
  ["North", 40],
  ["East", ""],
];
const doc = apply(emptyDoc(), {
  op: "set",
  sh: "s1",
  cells: rows.flatMap(([region, total], y) => [
    { r: id("r", y + 1), c: id("c", 1), v: region },
    ...(total === "" ? [] : [{ r: id("r", y + 1), c: id("c", 2), v: total }]),
  ]),
});
const box = { r1: id("r", 1), r2: id("r", 5), c1: id("c", 1), c2: id("c", 2) };
const hiddenBy = (rules: SheetFilter["rules"]) => {
  const filtered = apply(doc, { op: "filter", sh: "s1", filter: { box, rules } });
  return [
    ...filteredRows(
      filtered,
      calculateSheet(filtered, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
      "s1",
    ),
  ];
};

describe("a sheet's AutoFilter", () => {
  it("hides the rows whose shown value a column does not keep", () => {
    expect(hiddenBy({ [id("c", 1)]: { values: ["North"] } })).toEqual([id("r", 3), id("r", 5)]);
    // The header row is never filtered, and an empty cell is "".
    expect(hiddenBy({ [id("c", 2)]: { values: ["", "80"] } })).toEqual([id("r", 2), id("r", 4)]);
  });

  it("tests numbers as numbers and text without case, and every column must pass", () => {
    expect(hiddenBy({ [id("c", 2)]: { condition: { op: "greater", value: 50 } } })).toEqual([
      id("r", 4),
      id("r", 5),
    ]);
    expect(
      hiddenBy({
        [id("c", 1)]: { condition: { op: "beginsWith", value: "n" } },
        [id("c", 2)]: { condition: { op: "lessOrEqual", value: 100 } },
      }),
    ).toEqual([id("r", 2), id("r", 3), id("r", 5)]);
    expect(hiddenBy({ [id("c", 2)]: { condition: { op: "empty" } } })).toHaveLength(3);
  });

  it("is checked on the wire, undone like any change, and taken off with null", () => {
    expect(isSheetFilter({ box, rules: { [id("c", 1)]: { condition: { op: "nope" } } } })).toBe(
      false,
    );
    const filtered = apply(doc, { op: "filter", sh: "s1", filter: { box, rules: {} } });
    expect(apply(filtered, ...invertChange(doc, filtered)).sheet.s1!.filter).toBeUndefined();
    expect(
      apply(filtered, { op: "filter", sh: "s1", filter: null }).sheet.s1!.filter,
    ).toBeUndefined();
  });
});
