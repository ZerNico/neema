import { describe, expect, it } from "vitest";
import { XError } from "@chat/sheet/engine/values";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc } from "@chat/sheet/model";
import { calculateForWire, cellKey, fromWire } from "./calc-protocol.ts";

describe("values sent from the calculation worker", () => {
  it("carry formulas' results, spilled values and errors as plain data", () => {
    let doc = emptyDoc();
    const formula = (text: string) => {
      const parsed = parseFormula(text, { doc, sheet: "s1" });
      if (!("formula" in parsed)) throw new Error("needs growth");
      return parsed.formula;
    };
    doc = applyChange(
      doc,
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", f: formula("SEQUENCE(2)") },
              { r: "s1.r1", c: "s1.c2", f: formula("1/0") },
            ],
          },
        ],
      },
      1,
    ).doc;
    const result = calculateForWire({
      generation: 3,
      doc,
      context: { revision: 1, epoch: 0, now: 45_000, seed: 1 },
    });
    // It survives the structured copy a worker's message makes.
    const copied = structuredClone(result);
    const values = new Map(copied.results.map(([key, value]) => [key, fromWire(value)]));
    expect(values.get(cellKey("s1", "s1.r2", "s1.c1"))).toBe(2);
    expect(values.get(cellKey("s1", "s1.r1", "s1.c2"))).toEqual(new XError("#DIV/0!"));
    expect(copied.spills).toEqual([
      [cellKey("s1", "s1.r1", "s1.c1"), ["s1.r1", "s1.r2"], ["s1.c1"]],
    ]);
    expect(copied.generation).toBe(3);
  });
});
