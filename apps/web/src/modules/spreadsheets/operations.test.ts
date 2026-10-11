import { describe, expect, it } from "vitest";
import { parseCell, parseRange } from "@chat/sheet/a1";
import { describeSpreadsheetChanges, parseSpreadsheetOperations } from "./operations.ts";
import {
  renameSheetInFormula,
  shiftFormula,
  toEngineFormula,
  toFileFormula,
} from "./server/formulas.ts";

describe("spreadsheet operations", () => {
  it("accepts near misses a model makes and names the path of what it can't", () => {
    const [operation] = parseSpreadsheetOperations(
      JSON.stringify([{ kind: "setCells", sheet: "Sheet1", start: "b2", rows: [1, "two", null] }]),
    );
    // One row given flat, and a lower-case reference.
    expect(operation).toEqual({
      kind: "setCells",
      sheet: "Sheet1",
      start: "B2",
      rows: [[1, "two", null]],
    });
    expect(() =>
      parseSpreadsheetOperations([
        { kind: "setColumnWidth", sheet: "S", columns: "A", width: "wide" },
      ]),
    ).toThrow(/operations\[0\] setColumnWidth\.width: expected a number from 1 to 255/);
    expect(() =>
      parseSpreadsheetOperations([
        {
          kind: "addChart",
          sheet: "S",
          type: "pie",
          at: "A1",
          series: [{ values: "A1:A2" }, { values: "B1:B2" }],
        },
      ]),
    ).toThrow(/exactly one series/);
    expect(() =>
      parseSpreadsheetOperations([{ kind: "setFormat", sheet: "S", range: "A1" }]),
    ).toThrow(/at least one property/);
    expect(() => parseSpreadsheetOperations([{ kind: "addSheet", name: "a/b" }])).toThrow(
      /cannot contain/,
    );
  });

  it("bounds cells per call and ranges to the grid", () => {
    const row = Array.from({ length: 200 }, () => 1);
    expect(() =>
      parseSpreadsheetOperations([
        { kind: "setCells", sheet: "S", start: "A1", rows: Array.from({ length: 101 }, () => row) },
      ]),
    ).toThrow(/at most 20000 cells per call/);
    expect(parseCell("XFD1048576")).toEqual({ row: 1_048_576, column: 16_384 });
    expect(parseCell("XFE1")).toBeNull();
    expect(parseRange("C3:A1")).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
  });

  it("summarizes a batch for people", () => {
    expect(
      describeSpreadsheetChanges(
        parseSpreadsheetOperations([
          { kind: "setCells", sheet: "S", start: "A1", rows: [[1]] },
          { kind: "setCells", sheet: "S", start: "A3", rows: [[1]] },
          { kind: "addChart", sheet: "S", type: "line", at: "D2", series: [{ values: "A1:A3" }] },
        ]),
      ),
    ).toBe("Wrote 2 cell ranges and added a chart");
  });
});

describe("formula text", () => {
  it("moves a shared formula's relative references and keeps anchored ones", () => {
    expect(shiftFormula("SUM(A1:B2)*$C$1+Sheet2!A1+LOG10(D4)", 2, 1)).toBe(
      "SUM(B3:C4)*$C$1+Sheet2!B3+LOG10(E6)",
    );
    expect(shiftFormula('A1&"A1"', 1, 0)).toBe('A2&"A1"');
  });

  it("namespaces newer functions for the file and strips them for the engine", () => {
    expect(toFileFormula('=XLOOKUP("xlookup(",A:A,B:B)+sum(1)')).toBe(
      '_xlfn.XLOOKUP("xlookup(",A:A,B:B)+sum(1)',
    );
    expect(toFileFormula("=FILTER(A1:A9,B1:B9>0)")).toBe("_xlfn._xlws.FILTER(A1:A9,B1:B9>0)");
    expect(toEngineFormula("_xlfn._xlws.SORT(A1:A3)")).toBe("=SORT(A1:A3)");
  });

  it("renames quoted and bare sheet references but never string text", () => {
    expect(
      renameSheetInFormula(
        "'My Data'!A1+Data!B2+'my data'!C3&\"'My Data'!A1\"",
        "My Data",
        "Totals",
      ),
    ).toBe("Totals!A1+Data!B2+Totals!C3&\"'My Data'!A1\"");
    expect(renameSheetInFormula("Data!A1+OldData!A1", "Data", "New Data")).toBe(
      "'New Data'!A1+OldData!A1",
    );
  });

  it("refuses a lone surrogate half, which XML can't carry, but keeps a whole pair", () => {
    expect(() =>
      parseSpreadsheetOperations([
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["a\udc00"]] },
      ]),
    ).toThrow(/control characters/);
    expect(
      parseSpreadsheetOperations([
        { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["cake \u{1F370}"]] },
      ]),
    ).toHaveLength(1);
  });
});
