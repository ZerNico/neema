import { parseCell, parseRange } from "@chat/sheet/a1";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import { styleKey } from "@chat/sheet/style";
import type { GridSheet } from "@chat/sheet-react/grid";
import type { SpreadsheetPreview } from "~/modules/spreadsheets/preview.ts";

/** Rows and columns drawn past a sheet's last cell, so it reads as a sheet rather than a table. */
const ROOM = { rows: 30, cols: 5 } as const;
const AT_LEAST = { rows: 100, cols: 26 } as const;
/** How far a merge alone widens the grid; one over the whole sheet is drawn that far. */
const MERGE_REACH = { rows: 10_000, cols: 702 } as const;
const rowKey = (row: number) => `r${row}`;
const colKey = (col: number) => `c${col}`;

/**
 * One sheet of a preview as the grid draws it, keyed by position, with the
 * values the file stored. `formula` gives a cell's formula as Excel shows it,
 * for the formula bar.
 */
export function previewSheet(preview: SpreadsheetPreview) {
  // Drawings and merges sit on cells too, past the last value or not.
  const reach = { rows: preview.rows, cols: preview.cols };
  for (const each of [...preview.charts, ...preview.images]) {
    reach.rows = Math.max(reach.rows, each.row);
    reach.cols = Math.max(reach.cols, each.col);
  }
  for (const ref of preview.merges) {
    const box = parseRange(ref);
    if (!box) continue;
    reach.rows = Math.max(reach.rows, Math.min(box.bottom, MERGE_REACH.rows));
    reach.cols = Math.max(reach.cols, Math.min(box.right, MERGE_REACH.cols));
  }
  // A cut-off sheet ends where its cells were cut, so nothing past them looks empty.
  const rowCount = preview.truncated
    ? preview.rows
    : Math.max(AT_LEAST.rows, reach.rows + ROOM.rows);
  const colCount = Math.max(AT_LEAST.cols, reach.cols + ROOM.cols);
  const boxOf = (ref: string) => {
    const box = parseRange(ref);
    if (!box || box.top > rowCount || box.left > colCount) return null;
    return {
      r1: rowKey(box.top),
      c1: colKey(box.left),
      r2: rowKey(Math.min(box.bottom, rowCount)),
      c2: colKey(Math.min(box.right, colCount)),
    };
  };
  const styleKeys = preview.styles.map(styleKey);
  const cells: Record<string, Record<string, { s?: string }>> = {};
  const values = new Map<string, Scalar>();
  const formulas = new Map<string, string>();
  for (const cell of preview.cells) {
    if (cell.row > rowCount || cell.col > colCount) continue;
    const [r, c] = [rowKey(cell.row), colKey(cell.col)];
    const s = cell.style === undefined ? undefined : styleKeys[cell.style];
    (cells[r] ??= {})[c] = s ? { s } : {};
    if (cell.value !== undefined)
      values.set(
        `${r}|${c}`,
        typeof cell.value === "object" ? new XError(cell.value.error) : cell.value,
      );
    if (cell.formula) formulas.set(`${r}|${c}`, cell.formula);
  }
  const rowProps: Record<string, { size?: number; hidden?: true }> = {};
  const colProps: Record<string, { size?: number; hidden?: true }> = {};
  for (const [row, points] of preview.heights) rowProps[rowKey(row)] = { size: points };
  for (const row of preview.hiddenRows) (rowProps[rowKey(row)] ??= {}).hidden = true;
  for (const [col, characters] of preview.widths) colProps[colKey(col)] = { size: characters };
  for (const col of preview.hiddenCols) (colProps[colKey(col)] ??= {}).hidden = true;
  const frozen = preview.freeze ? parseCell(preview.freeze) : null;
  const conditional = preview.conditional.flatMap((format) => {
    const box = boxOf(format.ref);
    return box ? [{ box, rule: format.rule }] : [];
  });
  const sheet: GridSheet = {
    name: preview.sheet,
    rows: Array.from({ length: rowCount }, (_, index) => rowKey(index + 1)),
    cols: Array.from({ length: colCount }, (_, index) => colKey(index + 1)),
    cells,
    rowProps,
    colProps,
    merges: preview.merges.flatMap((ref) => boxOf(ref) ?? []),
    freeze: {
      row: frozen && frozen.row > 1 ? rowKey(frozen.row - 1) : null,
      col: frozen && frozen.column > 1 ? colKey(frozen.column - 1) : null,
    },
    ...(conditional.length ? { conditional } : {}),
  };
  return {
    sheet,
    value: (r: string, c: string): Scalar => values.get(`${r}|${c}`) ?? null,
    formula: (r: string, c: string) => formulas.get(`${r}|${c}`),
    /** A drawing's corner cell, or null past what the grid draws. */
    cellAt: (row: number, col: number) =>
      row <= rowCount && col <= colCount ? { r: rowKey(row), c: colKey(col) } : null,
  };
}
