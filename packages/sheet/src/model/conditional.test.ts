import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { calculateSheet } from "./calc.ts";
import { conditionalLooks, isConditionalList, type ConditionalRule } from "./conditional.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
const numbers = [10, 40, 25, 40, "", "Total"];
const doc = apply(emptyDoc(), {
  op: "set",
  sh: "s1",
  cells: numbers.flatMap((v, y) => (v === "" ? [] : [{ r: id("r", y + 1), c: id("c", 1), v }])),
});
const box = { r1: id("r", 1), r2: id("r", 6), c1: id("c", 1), c2: id("c", 1) };
const red = { fill: "#FFC7CE", fontColor: "#9C0006" };
/** The rows a rule styles, by number, and their looks. */
const looksOf = (...rules: ConditionalRule[]) => {
  const ruled = apply(doc, {
    op: "conditional",
    sh: "s1",
    list: rules.map((rule, index) => ({ id: `cf${index}`, box, rule })),
  });
  const looks = conditionalLooks(
    ruled,
    calculateSheet(ruled, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
    "s1",
  );
  return new Map([...looks].map(([key, look]) => [Number(key.split("|")[0]!.slice(4)), look]));
};

describe("conditional formats", () => {
  it("highlights cells by comparison, text, rank, average, duplicates and blanks", () => {
    expect([
      ...looksOf({ kind: "compare", op: "greater", values: [20], style: red }).keys(),
    ]).toEqual([2, 3, 4]);
    expect([
      ...looksOf({ kind: "compare", op: "between", values: [30, 10], style: red }).keys(),
    ]).toEqual([1, 3]);
    expect([...looksOf({ kind: "text", op: "contains", text: "tot", style: red }).keys()]).toEqual([
      6,
    ]);
    expect([...looksOf({ kind: "top", count: 1, style: red }).keys()]).toEqual([2, 4]);
    expect([...looksOf({ kind: "top", count: 1, bottom: true, style: red }).keys()]).toEqual([1]);
    expect([...looksOf({ kind: "average", style: red }).keys()]).toEqual([2, 4]);
    expect([...looksOf({ kind: "duplicate", style: red }).keys()]).toEqual([2, 4]);
    expect([...looksOf({ kind: "blank", style: red }).keys()]).toEqual([5]);
  });

  it("colours a scale and draws bars from the range's smallest number to its largest", () => {
    const scale = looksOf({ kind: "scale", colors: ["#FFFFFF", "#000000"] });
    expect([scale.get(1)?.fill, scale.get(2)?.fill]).toEqual(["#FFFFFF", "#000000"]);
    expect(scale.get(3)?.fill).toBe("#808080");
    const bars = looksOf({ kind: "bar", color: "#638EC6" });
    expect(bars.get(2)?.bar).toEqual({ fraction: 1, color: "#638EC6" });
    expect(bars.get(6)).toBeUndefined();
  });

  it("keeps the first rule's style where rules overlap, and undoes like any change", () => {
    const both = looksOf(
      { kind: "compare", op: "greater", values: [20], style: { fill: "#FF0000" } },
      { kind: "compare", op: "greater", values: [0], style: { fill: "#00FF00", bold: true } },
    );
    expect(both.get(2)).toEqual({ fill: "#FF0000", bold: true });
    expect(both.get(1)).toEqual({ fill: "#00FF00", bold: true });
    expect(isConditionalList([{ id: "x", box, rule: { kind: "bar", color: "blue" } }])).toBe(false);
    const ruled = apply(doc, {
      op: "conditional",
      sh: "s1",
      list: [{ id: "x", box, rule: { kind: "blank", style: red } }],
    });
    expect(apply(ruled, ...invertChange(doc, ruled)).sheet.s1!.conditional).toBeUndefined();
  });
});
