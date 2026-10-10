import type { SheetDoc } from "./model.ts";
import { IMAGE_LIMITS } from "./image.ts";

/**
 * How big a live sheet document may grow. The editor refuses a change that
 * would cross a limit and the server checks every change; both use this.
 * Each counter says what it counts.
 */
export interface SheetLimits {
  /** Live sheets. */
  readonly sheets: number;
  /** Row and column entries per sheet, deleted ones included until they are folded away. */
  readonly rows: number;
  readonly cols: number;
  /** Cells holding a value, a formula or a format; a cleared cell keeping only its write version is not counted. */
  readonly cells: number;
  readonly formulas: number;
  /** References in one formula. */
  readonly refsPerFormula: number;
  /** Characters of one cell's text and of one formula's text. */
  readonly cellText: number;
  readonly formulaText: number;
  readonly merges: number;
  readonly charts: number;
  readonly names: number;
  /** Distinct formats in use. */
  readonly styles: number;
  /** The whole document as JSON, and one change as JSON. */
  readonly bytes: number;
  readonly changeBytes: number;
}

export const LIVE_LIMITS: SheetLimits = {
  sheets: 50,
  rows: 100_000,
  cols: 1_000,
  cells: 200_000,
  formulas: 50_000,
  refsPerFormula: 1_024,
  cellText: 32_767,
  formulaText: 8_192,
  merges: 10_000,
  charts: 50,
  names: 500,
  styles: 4_096,
  bytes: 8_000_000,
  changeBytes: 1_000_000,
};

/** Why a document is past its limits, or null. Walks the document once. */
export function overLimits(doc: SheetDoc, limits: SheetLimits = LIVE_LIMITS): string | null {
  const live = doc.sheets.filter((entry) => !entry.dead);
  if (live.length > limits.sheets) return `more than ${limits.sheets} sheets`;
  if (Object.keys(doc.charts).length > limits.charts) return `more than ${limits.charts} charts`;
  if (Object.keys(doc.images ?? {}).length > IMAGE_LIMITS.images)
    return `more than ${IMAGE_LIMITS.images} pictures`;
  if (Object.keys(doc.names).length > limits.names) return `more than ${limits.names} names`;
  let cells = 0;
  let formulas = 0;
  const styles = new Set<string>();
  for (const sheet of Object.values(doc.sheet)) {
    if (sheet.rows.length > limits.rows) return `more than ${limits.rows} rows on a sheet`;
    if (sheet.cols.length > limits.cols) return `more than ${limits.cols} columns on a sheet`;
    if (sheet.merges.length > limits.merges) return `more than ${limits.merges} merged ranges`;
    for (const row of Object.values(sheet.cells))
      for (const cell of Object.values(row)) {
        if (cell.v === undefined && cell.f === undefined && cell.s === undefined) continue;
        cells += 1;
        if (cell.s) styles.add(cell.s);
        if (typeof cell.v === "string" && cell.v.length > limits.cellText)
          return `a cell longer than ${limits.cellText} characters`;
        if (cell.f) {
          formulas += 1;
          let refs = 0;
          let text = 0;
          for (const part of cell.f.parts) {
            if (typeof part === "string") text += part.length;
            else {
              refs += 1;
              text += 12;
            }
          }
          if (refs > limits.refsPerFormula)
            return `a formula with more than ${limits.refsPerFormula} references`;
          if (text > limits.formulaText)
            return `a formula longer than ${limits.formulaText} characters`;
        }
      }
  }
  if (cells > limits.cells) return `more than ${limits.cells} cells in use`;
  if (formulas > limits.formulas) return `more than ${limits.formulas} formulas`;
  if (styles.size > limits.styles) return `more than ${limits.styles} different formats`;
  if (JSON.stringify(doc).length > limits.bytes) return "a document too large to keep live";
  return null;
}
