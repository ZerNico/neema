import type { GridSheet } from "./grid-model.ts";
import type { AxisLayout } from "./layout.ts";
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
  cells: GridSheet["cells"],
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

/** A merged range by row and column index, its corners included. */
interface Span {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/**
 * Every merged range by its anchor's indexes, and the ones over a row. A
 * row's are found when first asked and kept, never by listing each cell a
 * merge covers: one merge may cover the whole sheet.
 */
export function mergeIndex(sheet: GridSheet, rows: AxisLayout, cols: AxisLayout) {
  const rowAt = new Map(rows.ids.map((id, index) => [id, index]));
  const colAt = new Map(cols.ids.map((id, index) => [id, index]));
  const spans = new Map<string, Span>();
  for (const merge of sheet.merges) {
    const [top, bottom, left, right] = [
      rowAt.get(merge.r1),
      rowAt.get(merge.r2),
      colAt.get(merge.c1),
      colAt.get(merge.c2),
    ];
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      continue;
    spans.set(key(top, left), { top, left, bottom, right });
  }
  const all = [...spans.values()];
  const rowsSeen = new Map<number, readonly Span[]>();
  const inRow = (row: number): readonly Span[] => {
    let found = rowsSeen.get(row);
    if (!found) {
      found = all.filter((span) => span.top <= row && span.bottom >= row);
      rowsSeen.set(row, found);
    }
    return found;
  };
  /** Whether a merge hides the cell: inside one, but not its anchor. */
  const covered = (row: number, col: number) =>
    inRow(row).some(
      (span) => col >= span.left && col <= span.right && (row !== span.top || col !== span.left),
    );
  return { spans, covered, inRow };
}
