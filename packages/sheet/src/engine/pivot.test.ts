import { describe, expect, it } from "vitest";
import { pivotBy } from "./pivot.ts";
import { Grid, XError } from "./values.ts";

const options = {
  headers: 0,
  rowTotals: 1,
  rowSort: [],
  colTotals: 1,
  colSort: [],
  filter: null,
};
const column = (values: (string | number)[]) => new Grid(values.map((value) => [value]));

describe("PIVOTBY", () => {
  it("refuses a crossing too large to spill, from its size alone", () => {
    const count = 600;
    const keys = Array.from({ length: count }, (_, at) => `k${at}`);
    const result = pivotBy(
      column(keys),
      column(keys.toReversed()),
      column(keys.map(() => 1)),
      "SUM",
      options,
    );
    expect(result).toEqual(new XError("#SPILL!"));
  });

  it("sums each crossing and both totals from one pass over the rows", () => {
    const result = pivotBy(
      column(["a", "a", "b"]),
      column(["x", "y", "x"]),
      column([1, 2, 4]),
      "PERCENTOF",
      options,
    );
    expect(result).toBeInstanceOf(Grid);
    // a's share of column x (1 of 5), and of all (3 of 7).
    expect((result as Grid).rows[1]).toEqual(["a", 1 / 5, 1, 3 / 7]);
  });
});
