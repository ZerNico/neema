import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { calculateSheet } from "./calc.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";
import {
  allowed,
  invalidCells,
  isValidationList,
  listChoices,
  validationAt,
  type Validation,
} from "./validation.ts";

let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
const values = (doc: SheetDoc) =>
  calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 });
const doc = apply(emptyDoc(), {
  op: "set",
  sh: "s1",
  cells: [
    { r: id("r", 1), c: id("c", 3), v: "Open" },
    { r: id("r", 2), c: id("c", 3), v: "Done" },
    { r: id("r", 3), c: id("c", 3), v: "Open" },
    { r: id("r", 1), c: id("c", 1), v: "Closed" },
    { r: id("r", 2), c: id("c", 2), v: 12.5 },
  ],
});
const status: Validation = {
  id: "v1",
  box: { r1: id("r", 1), r2: id("r", 10), c1: id("c", 1), c2: id("c", 1) },
  rule: {
    kind: "list",
    source: { sh: "s1", box: { r1: id("r", 1), r2: id("r", 3), c1: id("c", 3), c2: id("c", 3) } },
  },
  onError: "stop",
  allowBlank: true,
};
const amount: Validation = {
  id: "v2",
  box: { r1: id("r", 1), r2: id("r", 10), c1: id("c", 2), c2: id("c", 2) },
  rule: { kind: "whole", test: "between", values: [1, 10] },
  onError: "warning",
  allowBlank: false,
};
const ruled = apply(doc, { op: "validations", sh: "s1", list: [status, amount] });

describe("data validation", () => {
  it("lists a range's distinct shown values, and allows only those, without case", () => {
    expect(listChoices(ruled, values(ruled), status.rule)).toEqual(["Open", "Done"]);
    expect(allowed(ruled, values(ruled), status, "x", "done")).toBe(true);
    expect(allowed(ruled, values(ruled), status, "x", "Maybe")).toBe(false);
    expect(allowed(ruled, values(ruled), status, null, "")).toBe(true);
  });

  it("tests whole numbers, finds a cell's rule, and circles what breaks it", () => {
    expect(allowed(ruled, values(ruled), amount, 5, "5")).toBe(true);
    expect(allowed(ruled, values(ruled), amount, 5.5, "5.5")).toBe(false);
    expect(allowed(ruled, values(ruled), amount, null, "")).toBe(false);
    expect(validationAt(ruled, "s1", id("r", 4), id("c", 2))?.id).toBe("v2");
    expect(validationAt(ruled, "s1", id("r", 4), id("c", 4))).toBeNull();
    expect([...invalidCells(ruled, values(ruled), "s1")].toSorted()).toEqual([
      `${id("r", 1)}|${id("c", 1)}`,
      `${id("r", 2)}|${id("c", 2)}`,
    ]);
  });

  it("is checked on the wire and undone like any change", () => {
    expect(isValidationList([{ ...amount, onError: "explode" }])).toBe(false);
    expect(isValidationList([{ ...status, rule: { kind: "list" } }])).toBe(false);
    expect(apply(ruled, ...invertChange(doc, ruled)).sheet.s1!.validations).toBeUndefined();
  });
});
