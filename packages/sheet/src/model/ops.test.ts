import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { emptyDoc } from "./model.ts";
import { parseChange } from "./ops.ts";
import { parseFormula, renderFormula } from "./formula.ts";

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

describe("applying formats and clears", () => {
  const apply = (doc: ReturnType<typeof emptyDoc>, ops: unknown[], seq = 1) =>
    applyChange(doc, { clientId: "c", seq, ops: ops as never }, seq);
  const grown = applyChange(
    emptyDoc(),
    {
      clientId: "c",
      seq: 1,
      ops: [
        {
          op: "insert",
          sh: "s1",
          axis: "columns",
          ids: Array.from({ length: 300 }, (_, index) => `x${index}`),
          after: null,
        },
      ],
    },
    1,
  ).doc;

  it("refuses a format over more cells than a sheet holds, before making any", () => {
    const result = apply(grown, [
      {
        op: "format",
        sh: "s1",
        area: { r1: null, r2: null, c1: null, c2: null },
        patch: { bold: true },
      },
    ]);
    expect(result.dropped).toEqual(["a format over more cells than a sheet holds"]);
    expect(Object.keys(result.doc.sheet.s1!.cells)).toHaveLength(0);
  });

  it("clears only the cells that exist, and gives a new cell its column's format", () => {
    let doc = apply(emptyDoc(), [
      { op: "set", sh: "s1", cells: [{ r: "s1.r2", c: "s1.c1", v: 1 }] },
      {
        op: "format",
        sh: "s1",
        area: { r1: null, r2: null, c1: "s1.c2", c2: "s1.c2" },
        patch: { numberFormat: "0%" },
      },
    ]).doc;
    const cleared = apply(
      doc,
      [
        {
          op: "clear",
          sh: "s1",
          area: { r1: null, r2: null, c1: null, c2: null },
          what: "contents",
        },
      ],
      2,
    ).doc;
    expect(cleared.sheet.s1!.cells["s1.r2"]?.["s1.c1"]?.v).toBeUndefined();
    // A row inserted later has no cells yet; what is typed into it takes the column's format.
    doc = apply(
      doc,
      [
        { op: "insert", sh: "s1", axis: "rows", ids: ["later"], after: "s1.r3" },
        { op: "set", sh: "s1", cells: [{ r: "later", c: "s1.c2", v: 0.5 }] },
      ],
      3,
    ).doc;
    expect(doc.sheet.s1!.cells.later?.["s1.c2"]?.s).toBe('{"numberFormat":"0%"}');
  });
});

describe("moving cells to another sheet", () => {
  it("keeps a moved formula's references: to moved cells they follow, to others they name the source", () => {
    let doc = applyChange(
      emptyDoc(),
      {
        clientId: "c",
        seq: 1,
        ops: [
          {
            op: "sheetAdd",
            id: "s2",
            name: "Other",
            after: "s1",
            rows: ["o1"],
            cols: ["p1", "p2", "p3"],
          },
        ],
      },
      1,
    ).doc;
    const read = (text: string) => {
      const parsed = parseFormula(text, { doc, sheet: "s1" });
      if (!("formula" in parsed)) throw new Error("needs growth");
      return parsed.formula;
    };
    doc = applyChange(
      doc,
      {
        clientId: "c",
        seq: 2,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: 5 },
              { r: "s1.r1", c: "s1.c2", f: read("A1*2") },
              { r: "s1.r1", c: "s1.c3", f: read("D1+1") },
            ],
          },
        ],
      },
      2,
    ).doc;
    doc = applyChange(
      doc,
      {
        clientId: "c",
        seq: 3,
        ops: [
          {
            op: "move",
            sh: "s1",
            box: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c3" },
            to: { sh: "s2", r: "o1", c: "p1" },
          },
        ],
      },
      3,
    ).doc;
    const shown = (c: string) =>
      renderFormula(doc.sheet.s2!.cells.o1![c]!.f!, { doc, sheet: "s2" });
    expect([shown("p2"), shown("p3")]).toEqual(["A1*2", "Sheet1!D1+1"]);
  });
});
