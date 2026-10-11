/**
 * A1 addresses: Excel's column letters, cell and range references and the
 * grid's bounds. Shared by the engine, the Excel file tools and live sheets.
 */

const CELL = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/;
/** Excel's own bounds: a reference past them is not a cell. */
export const MAX_ROW = 1_048_576;
export const MAX_COLUMN = 16_384;

/** "AB" → 28. */
export const columnIndex = (letters: string) =>
  [...letters].reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
export const columnLetters = (index: number) => {
  let letters = "";
  for (let rest = index; rest > 0; rest = Math.floor((rest - 1) / 26))
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  return letters;
};

/** A1 cell reference to 1-based row and column, or null. */
export function parseCell(raw: string): { row: number; column: number } | null {
  const match = CELL.exec(raw.trim().toUpperCase());
  if (!match) return null;
  const column = columnIndex(match[1]!);
  const row = Number(match[2]);
  return column <= MAX_COLUMN && row <= MAX_ROW ? { row, column } : null;
}
export interface CellBox {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}
/** "B2" or "A1:D9" (either corner first) to a normalized box, or null. */
export function parseRange(raw: string): CellBox | null {
  const [first, second, ...rest] = raw.trim().split(":");
  if (rest.length || !first) return null;
  const a = parseCell(first);
  const b = second === undefined ? a : parseCell(second);
  if (!a || !b) return null;
  return {
    top: Math.min(a.row, b.row),
    left: Math.min(a.column, b.column),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.column, b.column),
  };
}
export const boxRef = (box: CellBox) => {
  const start = `${columnLetters(box.left)}${box.top}`;
  const end = `${columnLetters(box.right)}${box.bottom}`;
  return start === end ? start : `${start}:${end}`;
};
export const boxArea = (box: CellBox) => (box.bottom - box.top + 1) * (box.right - box.left + 1);
