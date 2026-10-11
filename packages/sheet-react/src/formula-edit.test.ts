import { describe, expect, it } from "vitest";
import { DE_DE } from "@chat/sheet/locales";
import {
  acceptCompletion,
  callAt,
  completion,
  formulaRefs,
  insertRef,
  pointable,
  toggleAbsolute,
} from "./formula-edit.ts";
import { signatureOf } from "./formula-help.ts";

const NAMES = ["SUM", "SUMIF", "SUMIFS", "SUMPRODUCT", "VLOOKUP"];

describe("a formula as it is typed", () => {
  it("finds its references with their place in the text and their cells", () => {
    expect(formulaRefs('=SUM(A1:B3)+Data!$C$2&"D4"')).toEqual([
      { start: 5, end: 10, text: "A1:B3", sheet: null, top: 1, left: 1, bottom: 3, right: 2 },
      {
        start: 12,
        end: 21,
        text: "Data!$C$2",
        sheet: "Data",
        top: 2,
        left: 3,
        bottom: 2,
        right: 3,
      },
    ]);
    expect(formulaRefs("A1")).toEqual([]);
  });

  it("offers functions for a name being typed, and writes the chosen one with its parenthesis", () => {
    expect(completion("=1+su", 5, NAMES)).toEqual({
      start: 3,
      prefix: "SU",
      matches: ["SUM", "SUMIF", "SUMIFS", "SUMPRODUCT"],
    });
    expect(completion('="su', 4, NAMES)).toBeNull();
    expect(completion("=A1", 3, ["A1X"])).toBeNull();
    expect(acceptCompletion("=1+su", 5, 3, "SUMIF")).toEqual({ text: "=1+SUMIF(", caret: 9 });
  });

  it("knows which argument of which call the caret is in", () => {
    expect(callAt("=IF(A1>0,SUM(B1,", 16)).toEqual({ name: "SUM", argument: 1 });
    expect(callAt("=IF(A1>0,SUM(B1,B2),", 20)).toEqual({ name: "IF", argument: 2 });
    expect(signatureOf("SUM", 5)).toEqual({
      name: "SUM",
      args: ["number1", "[number2]", "…"],
      current: 1,
    });
  });

  it("points at cells after an operator, replacing the reference it pointed at last", () => {
    expect(pointable("=SUM(", 5)).toBe(true);
    expect(pointable("=A1", 3)).toBe(false);
    const first = insertRef("=SUM(", 5, "B2", null);
    expect(first).toEqual({ text: "=SUM(B2", caret: 7, pointed: { start: 5, end: 7 } });
    expect(insertRef(first.text, first.caret, "B2:C4", first.pointed).text).toBe("=SUM(B2:C4");
  });

  it("cycles a reference's $ marks with F4, as Excel does", () => {
    let state = { text: "=A1+Data!B2:C3", caret: 3 };
    const seen: string[] = [];
    for (let n = 0; n < 4; n++) {
      state = toggleAbsolute(state.text, state.caret)!;
      seen.push(state.text);
    }
    expect(seen).toEqual([
      "=$A$1+Data!B2:C3",
      "=A$1+Data!B2:C3",
      "=$A1+Data!B2:C3",
      "=A1+Data!B2:C3",
    ]);
    expect(toggleAbsolute("=A1+Data!B2:C3", 14)!.text).toBe("=A1+Data!$B$2:$C$3");
    expect(toggleAbsolute("=1+2", 2)).toBeNull();
  });
});

describe("a formula typed in a comma-decimal locale", () => {
  it("finds references, cycles $ and points after an array's column separator", () => {
    expect(formulaRefs("={A1\\B1}", DE_DE).map((ref) => [ref.text, ref.start])).toEqual([
      ["A1", 2],
      ["B1", 5],
    ]);
    expect(toggleAbsolute("={A1\\B1}", 6, DE_DE)).toEqual({ text: "={A1\\$B$1}", caret: 9 });
    expect(pointable("={A1\\", 5)).toBe(true);
  });

  it("counts arguments by ';', not by a decimal comma or an array's separators", () => {
    expect(callAt("=ROUND(1,5", 10, DE_DE)).toEqual({ name: "ROUND", argument: 0 });
    expect(callAt("=ROUND(1,5;2", 12, DE_DE)).toEqual({ name: "ROUND", argument: 1 });
    expect(callAt("=SUM({1\\2;3\\4}", 15, DE_DE)).toEqual({ name: "SUM", argument: 0 });
    expect(callAt("=SUM({1,2;3,4},A1", 18)).toEqual({ name: "SUM", argument: 1 });
  });
});
