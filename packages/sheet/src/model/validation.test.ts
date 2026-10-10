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
  withoutArea,
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

  it("is cleared from exactly the cells chosen, the rest of a rule kept around them", () => {
    const rule: Validation = {
      id: "v",
      box: { r1: id("r", 1), r2: id("r", 3), c1: id("c", 1), c2: id("c", 3) },
      rule: { kind: "list", values: ["Yes"] },
      onError: "stop",
      allowBlank: true,
    };
    const sheet = apply(doc, { op: "validations", sh: "s1", list: [rule] });
    let minted = 0;
    const kept = withoutArea(
      sheet,
      "s1",
      { top: 2, bottom: 2, left: 2, right: 2 },
      () => `n${++minted}`,
    );
    const corners = (each: Validation) =>
      `${each.box.r1}:${each.box.c1}-${each.box.r2}:${each.box.c2}`;
    expect(kept.map(corners)).toEqual([
      "s1.r1:s1.c1-s1.r1:s1.c3",
      "s1.r3:s1.c1-s1.r3:s1.c3",
      "s1.r2:s1.c1-s1.r2:s1.c1",
      "s1.r2:s1.c3-s1.r2:s1.c3",
    ]);
    expect(kept.map((each) => each.id)).toEqual(["v", "n1", "n2", "n3"]);
    // A rule wholly inside goes; one apart is untouched.
    expect(withoutArea(sheet, "s1", { top: 1, bottom: 5, left: 1, right: 5 }, () => "x")).toEqual(
      [],
    );
    expect(withoutArea(sheet, "s1", { top: 9, bottom: 9, left: 9, right: 9 }, () => "x")).toEqual([
      rule,
    ]);
  });
});
