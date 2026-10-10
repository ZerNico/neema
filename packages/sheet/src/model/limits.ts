import type { Sheet, SheetDoc } from "./model.ts";
import { IMAGE_LIMITS } from "./image.ts";

/**
 * How big a live sheet document may grow. The server checks every change and
 * refuses one that would cross a limit, which its tab then drops; an import
 * is checked before it is stored. Each counter says what it counts.
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

interface SheetMeasure {
  readonly over: string | null;
  readonly cells: number;
  readonly formulas: number;
  readonly styles: ReadonlySet<string>;
  readonly bytes: number;
}

/**
 * One sheet measured against the limits. A change makes a new object only of
 * the sheets it touches, so each is measured once per limits and a push costs
 * what it changed, not the whole document.
 */
const measures = new WeakMap<SheetLimits, WeakMap<Sheet, SheetMeasure>>();
function measureSheet(sheet: Sheet, limits: SheetLimits): SheetMeasure {
  const cache = measures.get(limits) ?? new WeakMap<Sheet, SheetMeasure>();
  measures.set(limits, cache);
  const known = cache.get(sheet);
  if (known) return known;
  const measure = (): SheetMeasure => {
    const empty = { cells: 0, formulas: 0, styles: new Set<string>(), bytes: 0 };
    if (sheet.rows.length > limits.rows)
      return { ...empty, over: `more than ${limits.rows} rows on a sheet` };
    if (sheet.cols.length > limits.cols)
      return { ...empty, over: `more than ${limits.cols} columns on a sheet` };
    if (sheet.merges.length > limits.merges)
      return { ...empty, over: `more than ${limits.merges} merged ranges` };
    let [cells, formulas] = [0, 0];
    const styles = new Set<string>();
    for (const row of Object.values(sheet.cells))
      for (const cell of Object.values(row)) {
        if (cell.v === undefined && cell.f === undefined && cell.s === undefined) continue;
        cells += 1;
        if (cell.s) styles.add(cell.s);
        if (typeof cell.v === "string" && cell.v.length > limits.cellText)
          return { ...empty, over: `a cell longer than ${limits.cellText} characters` };
        if (!cell.f) continue;
        formulas += 1;
        let [refs, text] = [0, 0];
        for (const part of cell.f.parts) {
          if (typeof part === "string") text += part.length;
          else {
            refs += 1;
            text += 12;
          }
        }
        if (refs > limits.refsPerFormula)
          return { ...empty, over: `a formula with more than ${limits.refsPerFormula} references` };
        if (text > limits.formulaText)
          return { ...empty, over: `a formula longer than ${limits.formulaText} characters` };
      }
    return { over: null, cells, formulas, styles, bytes: JSON.stringify(sheet).length };
  };
  const measured = measure();
  cache.set(sheet, measured);
  return measured;
}

/** Why a document is past its limits, or null. Sheets a change left alone are not measured again. */
export function overLimits(doc: SheetDoc, limits: SheetLimits = LIVE_LIMITS): string | null {
  const live = doc.sheets.filter((entry) => !entry.dead);
  if (live.length > limits.sheets) return `more than ${limits.sheets} sheets`;
  if (Object.keys(doc.charts).length > limits.charts) return `more than ${limits.charts} charts`;
  if (Object.keys(doc.images ?? {}).length > IMAGE_LIMITS.images)
    return `more than ${IMAGE_LIMITS.images} pictures`;
  if (Object.keys(doc.names).length > limits.names) return `more than ${limits.names} names`;
  let [cells, formulas, bytes] = [0, 0, 0];
  const styles = new Set<string>();
  for (const sheet of Object.values(doc.sheet)) {
    const measured = measureSheet(sheet, limits);
    if (measured.over) return measured.over;
    cells += measured.cells;
    formulas += measured.formulas;
    bytes += measured.bytes;
    for (const style of measured.styles) styles.add(style);
  }
  if (cells > limits.cells) return `more than ${limits.cells} cells in use`;
  if (formulas > limits.formulas) return `more than ${limits.formulas} formulas`;
  if (styles.size > limits.styles) return `more than ${limits.styles} different formats`;
  // Pictures are most of the bytes; their sources are counted, not serialized again.
  const pictures = Object.values(doc.images ?? {}).reduce(
    (total, image) => total + image.src.length,
    0,
  );
  const { sheet: _sheets, images: _images, ...rest } = doc;
  bytes += pictures + JSON.stringify(rest).length;
  if (bytes > limits.bytes) return "a document too large to keep live";
  return null;
}
