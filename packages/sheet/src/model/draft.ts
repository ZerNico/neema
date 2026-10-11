import { applyChange } from "./apply.ts";
import { copyFormula, parseFormula } from "./formula.ts";
import { LIVE_LIMITS } from "./limits.ts";
import { positions, type Formula, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

/** Revisions a draft writes cells at: never a real one, so nothing reads them as anyone's. */
const DRAFT_REVISION = -1;

/**
 * A change being built: the operations so far and the document they make,
 * so each step is planned against what the ones before it did. The grid's
 * commands and the model's tool converter both build changes through one,
 * growing the grid the same way for what they write.
 */
export function draft(start: SheetDoc, mint: () => string) {
  let doc = start;
  const ops: SheetOp[] = [];
  const push = (...more: SheetOp[]) => {
    ops.push(...more);
    doc = applyChange(doc, { clientId: "draft", seq: 0, ops: more }, DRAFT_REVISION).doc;
  };
  /**
   * Grows a sheet to at least so many rows and columns, adding them at its
   * end; the limit it would pass, in words, when it cannot.
   */
  const ensure = (sheet: string, rows: number, cols: number): string | null => {
    for (const [axis, wanted, limit] of [
      ["rows", rows, LIVE_LIMITS.rows],
      ["columns", cols, LIVE_LIMITS.cols],
    ] as const) {
      const entries = axis === "rows" ? doc.sheet[sheet]!.rows : doc.sheet[sheet]!.cols;
      const have = positions(entries).ids.length;
      if (wanted <= have) continue;
      if (entries.length + wanted - have > limit)
        return `A live sheet holds at most ${limit} ${axis}.`;
      push({
        op: "insert",
        sh: sheet,
        axis,
        ids: Array.from({ length: wanted - have }, mint),
        after: entries.at(-1)?.id ?? null,
      });
    }
    return null;
  };
  /** Retries a step that asked for growth once the grid has it; null when it cannot grow so. */
  const grown = <T>(
    attempt: () =>
      | { formula: T }
      | { grow: ReadonlyArray<{ sheet: string; rows: number; cols: number }> },
  ): T | null => {
    for (let round = 0; round < 2; round++) {
      const result = attempt();
      if ("formula" in result) return result.formula;
      for (const each of result.grow) if (ensure(each.sheet, each.rows, each.cols)) return null;
    }
    return null;
  };
  return {
    get doc() {
      return doc;
    },
    ops,
    push,
    ensure,
    /** A formula typed on a sheet, the grid grown for what it reaches. */
    formula: (text: string, sheet: string): Formula | null =>
      grown(() => parseFormula(text, { doc, sheet })),
    /** A formula copied by a distance, the grid grown for where it then reaches. */
    copy: (
      formula: Formula,
      shift: { readonly rows: number; readonly cols: number },
      sheet: string,
      transposedFrom?: { readonly row: number; readonly col: number },
    ): Formula | null => grown(() => copyFormula(formula, shift, { doc, sheet }, transposedFrom)),
  };
}

export type Draft = ReturnType<typeof draft>;
