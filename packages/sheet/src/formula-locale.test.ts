import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { delocalizeFormula, localizeFormula } from "./formula-locale.ts";
import { DE_DE, EN_GB, EN_US, FR_FR } from "./locales.ts";

describe("a formula's separators in a locale", () => {
  it("are English where the decimal is a point", () => {
    for (const locale of [EN_US, EN_GB])
      expect(localizeFormula("=SUM(A1,B1)*1.5", locale)).toBe("=SUM(A1,B1)*1.5");
  });

  it("split arguments by ';' and decimals by ',' where the decimal is a comma", () => {
    expect(localizeFormula("=ROUND(A1,2)*1.5", DE_DE)).toBe("=ROUND(A1;2)*1,5");
    expect(localizeFormula("=SUM(G3,G5)+.5+2.5E-3", FR_FR)).toBe("=SUM(G3;G5)+,5+2,5E-3");
    expect(delocalizeFormula("=ROUND(A1;2)*1,5", DE_DE)).toBe("=ROUND(A1,2)*1.5");
  });

  it("split array columns by '\\' and keep ';' between rows", () => {
    expect(localizeFormula("={1,2.5;3,4}", DE_DE)).toBe("={1\\2,5;3\\4}");
    expect(delocalizeFormula("={1\\2,5;3\\4}", DE_DE)).toBe("={1,2.5;3,4}");
    expect(localizeFormula("=SUM({1,2},3)", DE_DE)).toBe("=SUM({1\\2};3)");
  });

  it("leave text, sheet names, tables and names as they are", () => {
    const stored = `=IF(STDEV.S('Q1, 2.5'!A1:A3)>1.5,"a, b; 1.5",Sales[[#Headers],[Net, 2.5]])`;
    expect(localizeFormula(stored, DE_DE)).toBe(
      `=IF(STDEV.S('Q1, 2.5'!A1:A3)>1,5;"a, b; 1.5";Sales[[#Headers],[Net, 2.5]])`,
    );
    expect(delocalizeFormula(localizeFormula(stored, DE_DE), DE_DE)).toBe(stored);
  });

  it("read a ',' typed between names out of habit as a separator, between digits as a decimal", () => {
    expect(delocalizeFormula("=SUM(A1,B1)", DE_DE)).toBe("=SUM(A1,B1)");
    expect(delocalizeFormula("=ROUND(A1,2)", DE_DE)).toBe("=ROUND(A1,2)");
    expect(delocalizeFormula("=SUM(1,5)", DE_DE)).toBe("=SUM(1.5)");
  });

  it("come back unchanged from any formula's localized form", () => {
    const token = fc.constantFrom(
      "A1",
      "$B$2:C9",
      "SUM(",
      "STDEV.S(",
      ")",
      ",",
      "1.5",
      "42",
      ".25",
      "3E+2",
      '"x, 1.5; y"',
      "'My, sheet'!A1",
      "{1,2;3,4}",
      "Tbl[[#All],[a, b]]",
      "+",
      " ",
      "TRUE",
      "#N/A",
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 12 }), (tokens) => {
        const stored = `=${tokens.join("")}`;
        for (const locale of [EN_US, DE_DE, FR_FR])
          expect(delocalizeFormula(localizeFormula(stored, locale), locale)).toBe(stored);
      }),
      { numRuns: 500 },
    );
  });
});
