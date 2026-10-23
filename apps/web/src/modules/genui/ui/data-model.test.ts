import { describe, expect, it } from "vitest";
import { slicesOf, sortRows } from "./data-model.ts";

describe("sortRows", () => {
  const rows = [
    ["Item 10", 3],
    ["Item 2", null],
    ["Item 1", 12],
    ["", 7],
  ] as const;

  it("keeps the block's order until the reader sorts", () => {
    expect(sortRows(rows, null)).toBe(rows);
  });

  it("sorts numbers by value and text as a person reads it, blanks last either way", () => {
    const by = (column: number, descending: boolean) =>
      sortRows(rows, { column, descending }).map((row) => row[column]);
    expect(by(1, true)).toEqual([12, 7, 3, null]);
    expect(by(1, false)).toEqual([3, 7, 12, null]);
    expect(by(0, false)).toEqual(["Item 1", "Item 2", "Item 10", ""]);
    expect(by(0, true)).toEqual(["Item 10", "Item 2", "Item 1", ""]);
  });

  it("puts numbers before text in a mixed column", () => {
    const mixed = [["n/a"], [5], [2]] as const;
    expect(sortRows(mixed, { column: 0, descending: false }).map((r) => r[0])).toEqual([
      2,
      5,
      "n/a",
    ]);
  });
});

describe("slicesOf", () => {
  it("keeps up to four positive slices in the block's order", () => {
    expect(slicesOf(["A", "B", "C", "D"], [1, 0, 3, null])).toEqual([
      { name: "A", value: 1 },
      { name: "C", value: 3 },
    ]);
  });

  it("folds everything past the largest four into one Other, the block's own included", () => {
    expect(
      slicesOf(["Rent", "Other", "Food", "Fun", "Car", "Phone"], [900, 50, 300, 100, 200, 40]),
    ).toEqual([
      { name: "Rent", value: 900 },
      { name: "Food", value: 300 },
      { name: "Fun", value: 100 },
      { name: "Car", value: 200 },
      { name: "Other", value: 90 },
    ]);
  });

  it("adds up slices that share a name, so the chart never draws two of one colour", () => {
    expect(slicesOf(["A", "B", "A"], [5, 3, 2])).toEqual([
      { name: "A", value: 7 },
      { name: "B", value: 3 },
    ]);
  });
});
