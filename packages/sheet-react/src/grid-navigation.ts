import type { SheetLocale } from "@chat/sheet/locales";
import type { Sheet, SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import { cellStyle } from "@chat/sheet/model/style";
import { cellDisplay } from "./display.ts";
import { textWidth, type AxisLayout } from "./layout.ts";
import type { CellRef, SheetSelection } from "./selection.ts";

/** A cell by its row and column indexes, as merges and drawn cells are keyed. */
export const key = (row: number, col: number) => `${row}:${col}`;

/** At most this many ranges are selected at once. */
const MAX_RANGES = 50;
/** The selection's ranges with a new one begun at `at`, as Cmd or Ctrl and a click do. */
export const adding = (selection: SheetSelection, at: CellRef): SheetSelection => ({
  anchor: at,
  head: at,
  more: [...(selection.more ?? []), { anchor: selection.anchor, head: selection.head }].slice(
    -MAX_RANGES + 1,
  ),
});

/** A sheet's size in rows and columns and which cells hold something, by index. */
export interface FilledCells {
  readonly rows: number;
  readonly cols: number;
  readonly at: (row: number, col: number) => boolean;
}

export const onSheet = (cells: FilledCells, r: number, c: number) =>
  r >= 0 && r < cells.rows && c >= 0 && c < cells.cols;

/**
 * Where Ctrl+Arrow lands, as in Excel: the end of the run of filled cells it
 * starts in, else the next filled cell, else the sheet's edge.
 */
export function dataEdge(
  cells: FilledCells,
  row: number,
  col: number,
  down: number,
  right: number,
) {
  let [r, c] = [row, col];
  if (!onSheet(cells, r + down, c + right)) return [r, c] as const;
  if (cells.at(r, c) && cells.at(r + down, c + right)) {
    while (onSheet(cells, r + down, c + right) && cells.at(r + down, c + right))
      [r, c] = [r + down, c + right];
    return [r, c] as const;
  }
  [r, c] = [r + down, c + right];
  while (onSheet(cells, r + down, c + right) && !cells.at(r, c)) [r, c] = [r + down, c + right];
  return [r, c] as const;
}

/** The block of filled cells around a cell, as Ctrl+A first selects: grown while a neighbour holds something. */
export function regionAround(cells: FilledCells, row: number, col: number) {
  let [top, bottom, left, right] = [row, row, col, col];
  const any = (r1: number, r2: number, c1: number, c2: number) => {
    for (let r = Math.max(0, r1); r <= Math.min(cells.rows - 1, r2); r++)
      for (let c = Math.max(0, c1); c <= Math.min(cells.cols - 1, c2); c++)
        if (cells.at(r, c)) return true;
    return false;
  };
  for (let grew = true; grew;) {
    grew = false;
    if (top > 0 && any(top - 1, top - 1, left - 1, right + 1)) [top, grew] = [top - 1, true];
    if (bottom < cells.rows - 1 && any(bottom + 1, bottom + 1, left - 1, right + 1))
      [bottom, grew] = [bottom + 1, true];
    if (left > 0 && any(top, bottom, left - 1, left - 1)) [left, grew] = [left - 1, true];
    if (right < cells.cols - 1 && any(top, bottom, right + 1, right + 1))
      [right, grew] = [right + 1, true];
  }
  return { top, bottom, left, right };
}

/** The last row and column anything is written in, where Ctrl+End goes. */
export function usedEnd(
  cells: Sheet["cells"],
  rowIndex: ReadonlyMap<string, number>,
  colIndex: ReadonlyMap<string, number>,
) {
  let [row, col] = [0, 0];
  for (const [r, written] of Object.entries(cells)) {
    const at = rowIndex.get(r);
    if (at === undefined) continue;
    for (const c of Object.keys(written)) {
      const across = colIndex.get(c);
      if (across === undefined) continue;
      row = Math.max(row, at);
      col = Math.max(col, across);
    }
  }
  return [row, col] as const;
}

/**
 * What a double-click on a header's edge sizes it to, as Excel's AutoFit:
 * a column as wide as its widest shown text, a row as tall as its largest
 * font. Null when it holds nothing to fit.
 */
export function autofit(
  of: {
    cells: Sheet["cells"];
    values: SheetValues;
    sheet: string;
    locale: SheetLocale;
  },
  axis: "rows" | "columns",
  id: string,
): number | null {
  let largest = 0;
  for (const [r, row] of Object.entries(of.cells)) {
    if (axis === "rows" && r !== id) continue;
    for (const [c, cell] of Object.entries(row)) {
      if (axis === "columns" && c !== id) continue;
      const style = cellStyle(cell.s);
      const fontPx = style.fontSize ? (style.fontSize * 4) / 3 : 14;
      if (axis === "rows") {
        largest = Math.max(largest, Math.ceil(fontPx * 1.4));
        continue;
      }
      const shown = cellDisplay(of.values.value(of.sheet, r, c), style, of.locale).text;
      if (shown) largest = Math.max(largest, textWidth(shown, fontPx, style.bold) + 10);
    }
  }
  return largest ? Math.ceil(Math.max(axis === "columns" ? 24 : 20, largest)) : null;
}

/** Row and column indexes of every merged range, and the cells each hides. */
export function mergeIndex(doc: SheetDoc, sheet: string, rows: AxisLayout, cols: AxisLayout) {
  const rowAt = new Map(rows.ids.map((id, index) => [id, index]));
  const colAt = new Map(cols.ids.map((id, index) => [id, index]));
  const spans = new Map<string, { top: number; left: number; bottom: number; right: number }>();
  const covered = new Set<string>();
  const byRow = new Map<number, { top: number; left: number; bottom: number; right: number }[]>();
  for (const merge of doc.sheet[sheet]!.merges) {
    const [top, bottom, left, right] = [
      rowAt.get(merge.r1),
      rowAt.get(merge.r2),
      colAt.get(merge.c1),
      colAt.get(merge.c2),
    ];
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      continue;
    const span = { top, left, bottom, right };
    spans.set(key(top, left), span);
    for (let row = top; row <= bottom; row++) {
      const inRow = byRow.get(row) ?? [];
      inRow.push(span);
      byRow.set(row, inRow);
      for (let col: number = left; col <= right; col++)
        if (row !== top || col !== left) covered.add(key(row, col));
    }
  }
  return { spans, covered, byRow };
}
