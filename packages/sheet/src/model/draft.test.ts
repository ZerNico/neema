import { describe, expect, it } from "vitest";
import { draft } from "./draft.ts";
import { renderFormula } from "./formula.ts";
import { LIVE_LIMITS } from "./limits.ts";
import { emptyDoc, positions } from "./model.ts";

describe("a change being built", () => {
  it("grows the grid for a formula reaching past it, each step seeing the last", () => {
    let minted = 0;
    const plan = draft(emptyDoc(), () => `n${++minted}`);
    const first = plan.formula("AB1", "s1");
    const second = plan.formula("AC1", "s1");
    expect(renderFormula(second!, { doc: plan.doc, sheet: "s1" })).toBe("AC1");
    expect(first).not.toBeNull();
    // Columns were added once to reach AB, then once more to reach AC.
    expect(plan.ops.map((op) => (op.op === "insert" ? op.ids.length : 0))).toEqual([2, 1]);
    expect(positions(plan.doc.sheet.s1!.cols).ids).toHaveLength(29);
  });

  it("refuses growth past what a live sheet holds, writing nothing", () => {
    const plan = draft(emptyDoc(), () => "x");
    expect(plan.ensure("s1", LIVE_LIMITS.rows + 1, 1)).toBe(
      `A live sheet holds at most ${LIVE_LIMITS.rows} rows.`,
    );
    expect(plan.ops).toEqual([]);
  });
});
