import { getCachedFormulaValue, makeFormula, type CellValue } from "@office-kit/xlsx/cell";
import {
  addDefinedName,
  addWorksheet,
  createWorkbook,
  type Workbook,
} from "@office-kit/xlsx/workbook";
import { addExcelTable, getCell, setCell } from "@office-kit/xlsx/worksheet";
import { describe, expect, it } from "vitest";
import { recalculate } from "../calc.ts";
import { parseFormula, Unsupported } from "./parse.ts";

/** A one-sheet workbook from rows of values ("=…" is a formula), recalculated. */
function sheet(rows: CellValue[][], setup?: (workbook: Workbook) => void) {
  const workbook = createWorkbook();
  const data = addWorksheet(workbook, "Data");
  rows.forEach((row, r) =>
    row.forEach((value, c) =>
      setCell(
        data,
        r + 1,
        c + 1,
        typeof value === "string" && value.startsWith("=") ? makeFormula(value.slice(1)) : value,
      ),
    ),
  );
  setup?.(workbook);
  const report = recalculate(workbook);
  const at = (address: string) => {
    const match = /^([A-Z])(\d+)$/.exec(address)!;
    return getCachedFormulaValue(getCell(data, Number(match[2]), match[1]!.charCodeAt(0) - 64)!);
  };
  return { report, at };
}

describe("formula engine", () => {
  it("follows Excel's precedence and coercion", () => {
    const { at } = sheet([
      ["=-2^2", "=2+3*4", '="1"+1', "=10%", '="a"&1&TRUE', '=5>"a"', '="B"="b"', "=1/0"],
    ]);
    expect([
      at("A1"),
      at("B1"),
      at("C1"),
      at("D1"),
      at("E1"),
      at("F1"),
      at("G1"),
      at("H1"),
    ]).toEqual([4, 14, 2, 0.1, "a1TRUE", false, true, "#DIV/0!"]);
  });

  it("evaluates only the branch taken, and arrays element by element", () => {
    const { at, report } = sheet([
      [0, 2, 3, '=IF(A1=0,"none",1/A1)', '=IFERROR(1/A1,"safe")', "=SUMPRODUCT((B1:C1>2)*B1:C1)"],
      [1, '=IFS(A1>0,"pos",TRUE,"zero")', '=SWITCH(B1,2,"two","other")', '=CHOOSE(2,"a","b")'],
    ]);
    expect([at("D1"), at("E1"), at("F1"), at("B2"), at("C2"), at("D2")]).toEqual([
      "none",
      "safe",
      3,
      "zero",
      "two",
      "b",
    ]);
    expect(report.errorCount).toBe(0);
  });

  it("looks values up, including XLOOKUP and XMATCH which formula.js lacks", () => {
    const { at } = sheet([
      [
        "Apple",
        1,
        '=VLOOKUP("Pear",A1:B3,2,FALSE)',
        '=XLOOKUP("pear",A1:A3,B1:B3)',
        '=XLOOKUP("Kiwi",A1:A3,B1:B3,"none")',
        '=XMATCH("P*",A1:A3,2)',
      ],
      [
        "Pear",
        2,
        "=MATCH(3,B1:B3,0)",
        "=INDEX(B1:B3,3)",
        '=SUMIF(B1:B3,">1")',
        '=COUNTIFS(B1:B3,">=1",A1:A3,"<>Pear")',
      ],
      ["Plum", 3],
    ]);
    expect([
      at("C1"),
      at("D1"),
      at("E1"),
      at("F1"),
      at("C2"),
      at("D2"),
      at("E2"),
      at("F2"),
    ]).toEqual([2, 2, "none", 2, 3, 3, 5, 2]);
  });

  it("reads dates as Excel serials and names and whole columns as ranges", () => {
    const { at } = sheet(
      [
        [
          10,
          "=DATE(2024,1,31)",
          "=YEAR(B1)",
          "=EOMONTH(B1,1)",
          "=SUM(A:A)",
          "=AVERAGE(Rate)",
          "=ROW()",
          "=ROWS(A1:A3)",
        ],
        [20],
        [30],
      ],
      (workbook) => addDefinedName(workbook, { name: "Rate", value: "Data!$A$1:$A$3" }),
    );
    expect([at("B1"), at("C1"), at("D1"), at("E1"), at("F1"), at("G1"), at("H1")]).toEqual([
      45322, 2024, 45351, 60, 20, 1, 3,
    ]);
  });

  it("calculates a long chain in order without recursing, and flags a cycle but not its source", () => {
    const rows: CellValue[][] = [[1]];
    for (let row = 2; row <= 20_000; row++) rows.push([`=A${row - 1}+1`]);
    rows[0]!.push("=C1+1", "=B1+1", "=A1*2");
    const { at, report } = sheet(rows);
    // Deep enough that evaluating by recursion would overflow the stack.
    expect(at("A20000")).toBe(20_000);
    expect(report.errors).toEqual(
      expect.arrayContaining([
        { cell: "Data!B1", error: "#CIRCULAR" },
        { cell: "Data!C1", error: "#CIRCULAR" },
      ]),
    );
    expect(report.errors).not.toContainEqual(expect.objectContaining({ cell: "Data!D1" }));
    expect(at("D1")).toBe(2);
  });

  it("leaves what it can't evaluate to the file's value", () => {
    expect(() => parseFormula("SUM(Table1[Sales])")).toThrow(Unsupported);
    expect(() => parseFormula("[Wanted]")).toThrow(Unsupported);
    const { at, report } = sheet([[1, "=NOW()", "=LAMBDA(x,x)(1)"]]);
    expect(report.unsupported).toEqual(expect.arrayContaining(["NOW"]));
    expect(at("B1")).toBeUndefined();
  });

  it("reads a range by implicit intersection in a legacy formula, element by element in a new one", () => {
    const workbook = createWorkbook();
    const data = addWorksheet(workbook, "Data");
    [1, 2, 3].forEach((value, index) => setCell(data, index + 1, 1, value));
    setCell(data, 2, 2, makeFormula("A1:A3*10"));
    const fresh = setCell(data, 5, 3, makeFormula("A1:A3*10"));
    recalculate(workbook, { authored: new Set([fresh]) });
    // Legacy: row 2 meets A2. New: the result spills down from C5.
    expect(getCachedFormulaValue(getCell(data, 2, 2)!)).toBe(20);
    expect(getCell(data, 5, 3)!.value).toMatchObject({ t: "array", ref: "C5:C7", cachedValue: 10 });
    expect([getCell(data, 6, 3)!.value, getCell(data, 7, 3)!.value]).toEqual([20, 30]);
  });

  it("shows #SPILL! where a spill would cover a value, and spills again once it is gone", () => {
    const workbook = createWorkbook();
    const data = addWorksheet(workbook, "Data");
    setCell(data, 1, 1, makeFormula("SEQUENCE(3)"));
    setCell(data, 3, 1, "in the way");
    const anchor = getCell(data, 1, 1)!;
    recalculate(workbook, { authored: new Set([anchor]) });
    expect(anchor.value).toMatchObject({
      cachedValue: "#SPILL!",
      cachedValueType: "error",
      ref: "A1",
    });
    getCell(data, 3, 1)!.value = null;
    recalculate(workbook);
    expect(anchor.value).toMatchObject({ ref: "A1:A3", cachedValue: 1 });
    expect(getCell(data, 3, 1)!.value).toBe(3);
  });

  it("orders a formula after the spill it reads, even one that grew this calculation", () => {
    const workbook = createWorkbook();
    const data = addWorksheet(workbook, "Data");
    setCell(data, 1, 1, 3);
    const spill = setCell(data, 1, 2, makeFormula("SEQUENCE(A1)"));
    setCell(data, 1, 3, makeFormula("SUM(B1:B5)"));
    recalculate(workbook, { authored: new Set([spill]) });
    expect(getCachedFormulaValue(getCell(data, 1, 3)!)).toBe(6);
  });

  it("evaluates tables, LET, INDIRECT, OFFSET and 3-D references", () => {
    const workbook = createWorkbook();
    const one = addWorksheet(workbook, "One");
    const two = addWorksheet(workbook, "Two");
    [
      ["Item", "Qty"],
      ["a", 2],
      ["b", 5],
    ].forEach((row, r) => row.forEach((value, c) => setCell(one, r + 1, c + 1, value)));
    addExcelTable(workbook, one, { name: "Stock", ref: "A1:B3", columns: ["Item", "Qty"] });
    setCell(two, 1, 1, 7);
    const formulas = [
      "SUM(Stock[Qty])",
      "LET(x,Stock[Qty],SUM(x*2))",
      'INDIRECT("One!B"&3)',
      "SUM(OFFSET(One!B2,0,0,2,1))",
      "SUM(One:Two!A1:B1)",
    ];
    const cells = formulas.map((formula, index) =>
      setCell(two, 2, index + 1, makeFormula(formula)),
    );
    recalculate(workbook, { authored: new Set(cells) });
    expect(formulas.map((_, index) => getCachedFormulaValue(getCell(two, 2, index + 1)!))).toEqual([
      7, 14, 5, 7, 7,
    ]);
  });

  it("matches wildcards without backtracking on text from cells", () => {
    const { at } = sheet([
      [
        "a".repeat(20_000),
        '=COUNTIF(A1,"*a*a*a*a*a*a*a*a*b")',
        '=SEARCH("c?e","abcdef")',
        '=COUNTIF(A2:A3,"?ig")',
      ],
      ["fig"],
      ["figs"],
    ]);
    expect([at("B1"), at("C1"), at("D1")]).toEqual([0, 3, 1]);
  });
});
