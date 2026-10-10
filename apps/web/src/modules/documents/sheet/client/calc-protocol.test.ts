import { describe, expect, it } from "vitest";
import { XError } from "@chat/sheet/engine/values";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc } from "@chat/sheet/model";
import { calculateForWire, cellKey, fromWire, valuesOf } from "./calc-protocol.ts";

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

  it("empties a cleared formula's cells at once, before the worker answers again", () => {
    let doc = emptyDoc();
    const parsed = parseFormula("SEQUENCE(2)", { doc, sheet: "s1" });
    if (!("formula" in parsed)) throw new Error("needs growth");
    const context = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
    const set = (cells: Parameters<typeof applyChange>[1]["ops"]) =>
      applyChange(doc, { clientId: "t", seq: 1, ops: cells }, 1).doc;
    doc = set([{ op: "set", sh: "s1", cells: [{ r: "s1.r1", c: "s1.c1", f: parsed.formula }] }]);
    const result = calculateForWire({ generation: 1, doc, context });
    expect(valuesOf(doc, context, result).value("s1", "s1.r2", "s1.c1")).toBe(2);
    // The last answer is for the formula; the document no longer has it.
    const cleared = set([
      {
        op: "clear",
        sh: "s1",
        area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
        what: "contents",
      },
    ]);
    const shown = valuesOf(cleared, context, result);
    expect([shown.value("s1", "s1.r1", "s1.c1"), shown.value("s1", "s1.r2", "s1.c1")]).toEqual([
      null,
      null,
    ]);
  });
});
