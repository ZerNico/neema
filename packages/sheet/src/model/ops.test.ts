import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { emptyDoc } from "./model.ts";
import { parseChange } from "./ops.ts";

const accepts = (op: unknown) => parseChange({ clientId: "c", seq: 1, ops: [op] }).ok;
const formula = { parts: ["1"] };

describe("a change from the wire", () => {
  it("refuses an array formula past what a spill may fill, or one without a formula", () => {
    const write = (array: unknown, f: unknown = formula) => ({
      op: "set",
      sh: "s1",
      cells: [{ r: "s1.r1", c: "s1.c1", f, array }],
    });
    expect(accepts(write({ rows: 2, cols: 3 }))).toBe(true);
    expect(accepts(write({ rows: 1e9, cols: 1e9 }))).toBe(false);
    expect(accepts(write({ rows: 1.5, cols: 1 }))).toBe(false);
    expect(
      accepts({
        op: "set",
        sh: "s1",
        cells: [{ r: "s1.r1", c: "s1.c1", v: 1, array: { rows: 2, cols: 2 } }],
      }),
    ).toBe(false);
  });

  it("takes a sort only as the same rows each once, and inserts each new ID once", () => {
    const sort = (order: string[]) => ({
      op: "sort",
      sh: "s1",
      c1: "s1.c1",
      c2: "s1.c1",
      rows: ["s1.r1", "s1.r2"],
      order,
    });
    expect(accepts(sort(["s1.r2", "s1.r1"]))).toBe(true);
    expect(accepts(sort(["s1.r1", "s1.r1"]))).toBe(false);
    expect(accepts(sort(["s1.r1", "s1.r9"]))).toBe(false);
    expect(accepts({ op: "insert", sh: "s1", axis: "rows", ids: ["n", "n"], after: null })).toBe(
      false,
    );
    // Applied anyway, a repeated ID is added once.
    const doc = applyChange(
      emptyDoc(),
      {
        clientId: "c",
        seq: 1,
        ops: [{ op: "insert", sh: "s1", axis: "rows", ids: ["n", "n"], after: null }],
      },
      1,
    ).doc;
    expect(doc.sheet.s1!.rows.filter((entry) => entry.id === "n")).toHaveLength(1);
  });

  it("refuses IDs that name what every object has, and unknown or ill-typed styles", () => {
    expect(accepts({ op: "chartDelete", id: "constructor" })).toBe(false);
    expect(accepts({ op: "chartDelete", id: "__proto__" })).toBe(false);
    const format = (patch: unknown) => ({
      op: "format",
      sh: "s1",
      area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
      patch,
    });
    expect(accepts(format({ bold: true, numberFormat: "0.00", fill: "#FFC000", link: null }))).toBe(
      true,
    );
    expect(accepts(format({ numberFormat: 123 }))).toBe(false);
    expect(accepts(format({ fontFamily: "x;background:url(https://evil)" }))).toBe(false);
    expect(accepts(format({ fill: "red" }))).toBe(false);
    expect(accepts(format({ link: "javascript:alert(1)" }))).toBe(false);
    expect(accepts(format({ shadow: true }))).toBe(false);
  });
});
