import { describe, expect, it } from "vitest";
import { lex, type Lexeme } from "./parse.ts";

const refs = (formula: string) =>
  lex(formula).flatMap((piece) => (piece.k === "ref" ? [piece] : []));
const joined = (pieces: Lexeme[]) => pieces.map((piece) => piece.text).join("");

describe("lexing a formula without losing anything", () => {
  const formulas = [
    "SUM($A$1:B2)*Sheet2!C:C",
    "'My Sheet'!$3:$4+First:Last!A1",
    '"A1 is text"&Tax_Rate&IF(B$7>0,  $C9, #N/A)',
    "Table1[[#Headers],[Amount]]+[@Price]*2",
    "SUM(A1:A3 B2:B4)+_xlfn.XLOOKUP(D1,E:E,F:F)",
    "AB12345678+LOG10(2)",
  ];

  it("gives back the formula exactly when its pieces are joined", () => {
    for (const formula of formulas) expect(joined(lex(formula))).toBe(formula);
  });

  it("keeps each reference's kind and every $", () => {
    expect(refs("SUM($A$1:B2)")).toEqual([
      {
        k: "ref",
        text: "$A$1:B2",
        sheet: null,
        sheets: null,
        from: { row: 1, column: 1, rowAbsolute: true, columnAbsolute: true },
        to: { row: 2, column: 2, rowAbsolute: false, columnAbsolute: false },
      },
    ]);
    const [columns, rows, cell] = refs("Sheet2!C:C+'My Sheet'!$3:$4+B$7");
    expect(columns).toMatchObject({
      sheet: "Sheet2",
      from: { row: null, column: 3 },
      to: { row: null, column: 3 },
    });
    expect(rows).toMatchObject({
      sheet: "My Sheet",
      from: { row: 3, column: null, rowAbsolute: true },
      to: { row: 4, rowAbsolute: true },
    });
    expect(cell).toMatchObject({
      from: { row: 7, column: 2, rowAbsolute: true, columnAbsolute: false },
    });
    expect(refs("First:Last!A1")[0]).toMatchObject({
      sheet: null,
      sheets: { first: "First", last: "Last" },
    });
  });

  it("leaves strings, names, functions and table references as text", () => {
    expect(refs('"A1 is text"&Tax_Rate&LOG10(2)')).toEqual([]);
    expect(refs("Table1[[#Headers],[Amount]]+[@Price]*2")).toEqual([]);
    // Past Excel's last row or column, it is not a reference Excel would read.
    expect(refs("AB12345678")).toEqual([]);
    expect(refs("XFE1+1")).toEqual([]);
  });
});
