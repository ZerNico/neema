import { describe, expect, it } from "vitest";
import { toEngineFormula, toFileFormula } from "./formulas.ts";

describe("formulas in Excel files", () => {
  it("stores GROUPBY's function in Excel's eta form, and reads it back", () => {
    const stored = toFileFormula("=GROUPBY(A2:A6, C2:C6, sum, 3)");
    expect(stored).toBe("_xlfn.GROUPBY(A2:A6, C2:C6, _xleta.SUM, 3)");
    expect(toFileFormula("=PIVOTBY(A2:A6,B2:B6,C2:C6,PERCENTOF)")).toBe(
      "_xlfn.PIVOTBY(A2:A6,B2:B6,C2:C6,_xleta.PERCENTOF)",
    );
    // A call stays a call, and outside GROUPBY a name is left alone.
    expect(toFileFormula("=SUM(A1:A3)+MAX(B1)")).toBe("SUM(A1:A3)+MAX(B1)");
    expect(toEngineFormula(stored)).toBe("=GROUPBY(A2:A6, C2:C6, SUM, 3)");
  });
});
