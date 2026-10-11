import { describe, expect, it } from "vitest";
import { pivotFormula } from "./pivot.ts";

describe("a pivot table's formula", () => {
  it("names each field as a whole absolute column of the data, on its sheet", () => {
    const box = { top: 1, bottom: 20, left: 2 };
    const base = { rows: 0, values: 2, summary: "SUM", place: "sheet", headers: true } as const;
    expect(pivotFormula("Sales 2026", box, { ...base, columns: null })).toBe(
      "=GROUPBY('Sales 2026'!$B$1:$B$20,'Sales 2026'!$D$1:$D$20,SUM,3)",
    );
    expect(
      pivotFormula("Data", box, { ...base, columns: 1, summary: "AVERAGE", headers: false }),
    ).toBe("=PIVOTBY(Data!$B$1:$B$20,Data!$C$1:$C$20,Data!$D$1:$D$20,AVERAGE,0)");
  });
});
