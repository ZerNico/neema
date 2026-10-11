import { columnIndex, columnLetters, MAX_COLUMN, MAX_ROW } from "../a1.ts";
import { lex, type RefCorner as LexCorner } from "../engine/parse.ts";
import {
  positions,
  sheetNamed,
  type Formula,
  type IdRef,
  type RefCorner,
  type SheetDoc,
  type SpanRef,
} from "./model.ts";

/** Where a formula is read or written: the document and the sheet it sits on. */
export interface FormulaAt {
  readonly doc: SheetDoc;
  readonly sheet: string;
}

/** Rows or columns a reference reaches past the sheet's grid, which must exist before it can be held. */
export interface Growth {
  readonly sheet: string;
  readonly rows: number;
  readonly cols: number;
}

const BARE_SHEET = /^[A-Za-z_À-￿][\w.À-￿]*$/;
/** A sheet name as a formula writes it: quoted unless it is a plain name that can't pass for a cell. */
export const quoteSheet = (name: string) =>
  BARE_SHEET.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !/^(true|false)$/i.test(name)
    ? name
    : `'${name.replaceAll("'", "''")}'`;

const REF_ERROR = "#REF!";

/**
 * Reads typed formula text (no leading `=`) into its stored form, by the
 * grid as it is now. A reference past the grid comes back as the growth it
 * needs; a sheet nobody has is kept as text and fails when calculated.
 */
export function parseFormula(
  text: string,
  at: FormulaAt,
): { formula: Formula } | { grow: Growth[] } {
  const parts: Formula["parts"][number][] = [];
  const grow = new Map<string, { rows: number; cols: number }>();
  const need = (sheet: string, rows: number, cols: number) => {
    const known = grow.get(sheet) ?? { rows: 0, cols: 0 };
    grow.set(sheet, { rows: Math.max(known.rows, rows), cols: Math.max(known.cols, cols) });
  };
  for (const piece of lex(text)) {
    if (piece.k === "text") {
      parts.push(piece.text);
      continue;
    }
    if (piece.sheets) {
      const first = sheetNamed(at.doc, piece.sheets.first);
      const last = sheetNamed(at.doc, piece.sheets.last);
      if (!first || !last) {
        parts.push(piece.text);
        continue;
      }
      const area = piece.text.slice(piece.text.lastIndexOf("!") + 1);
      parts.push({ k: "span", first, last, area } satisfies SpanRef);
      continue;
    }
    const sheetId = piece.sheet === null ? at.sheet : sheetNamed(at.doc, piece.sheet);
    if (!sheetId) {
      parts.push(piece.text);
      continue;
    }
    const sheet = at.doc.sheet[sheetId]!;
    const rows = positions(sheet.rows);
    const cols = positions(sheet.cols);
    // A range reaching Excel's last row or column is open-ended there: it follows the grid.
    const corner = (raw: LexCorner, open: boolean): RefCorner | null => {
      const row = raw.row === null || (open && raw.row === MAX_ROW) ? null : raw.row;
      const col = raw.column === null || (open && raw.column === MAX_COLUMN) ? null : raw.column;
      if ((row !== null && row > rows.ids.length) || (col !== null && col > cols.ids.length)) {
        need(sheetId, row ?? 0, col ?? 0);
        return null;
      }
      return {
        row: row === null ? null : rows.ids[row - 1]!,
        col: col === null ? null : cols.ids[col - 1]!,
        rowAbs: raw.rowAbsolute,
        colAbs: raw.columnAbsolute,
      };
    };
    const ranged = piece.to !== null;
    const from = corner(piece.from, false);
    const to = piece.to ? corner(piece.to, true) : null;
    if (!from || (ranged && !to)) continue;
    parts.push({
      k: "ref",
      sheet: piece.sheet === null ? null : sheetId,
      from,
      to,
    } satisfies IdRef);
  }
  if (grow.size) return { grow: [...grow].map(([sheet, size]) => ({ sheet, ...size })) };
  return { formula: { parts: joinText(parts) } };
}

const joinText = (parts: Formula["parts"][number][]) => {
  const out: Formula["parts"][number][] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (typeof part === "string" && typeof last === "string") out[out.length - 1] = last + part;
    else out.push(part);
  }
  return out;
};

/** A reference's corners at current positions, or null when it no longer points anywhere. */
function locate(ref: IdRef, at: FormulaAt) {
  const sheetId = ref.sheet ?? at.sheet;
  const entry = at.doc.sheets.find((each) => each.id === sheetId);
  const sheet = at.doc.sheet[sheetId];
  if (!sheet || !entry || entry.dead) return null;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  // A dead endpoint moves inward, toward the other corner; a single dead cell has nowhere to go.
  const place = (
    index: typeof rows,
    from: string | null,
    to: string | null,
    open: number,
  ): [number, number] | null => {
    if (from === null && to === null) return [1, open];
    if (to === null && ref.to !== null) {
      const start = from === null ? 1 : (index.at(from) ?? index.nearest(from, 1));
      return start === undefined ? null : [start, open];
    }
    if (from === null) return null;
    const second = to ?? from;
    const [a, b] = [index.raw(from), index.raw(second)];
    if (a === undefined || b === undefined) return null;
    const forward: 1 | -1 = a <= b ? 1 : -1;
    const start = index.at(from) ?? (ref.to ? index.nearest(from, forward) : undefined);
    const end =
      index.at(second) ?? (ref.to ? index.nearest(second, forward === 1 ? -1 : 1) : undefined);
    if (start === undefined || end === undefined) return null;
    if (forward === 1 ? start > end : start < end) return null;
    return [start, end];
  };
  const rowSpan = place(rows, ref.from.row, ref.to ? ref.to.row : ref.from.row, MAX_ROW);
  const colSpan = place(cols, ref.from.col, ref.to ? ref.to.col : ref.from.col, MAX_COLUMN);
  if (!rowSpan || !colSpan) return null;
  return { sheet, rowSpan, colSpan };
}

const cornerText = (row: number | null, col: number | null, corner: RefCorner) =>
  `${col === null ? "" : `${corner.colAbs ? "$" : ""}${columnLetters(col)}`}${
    row === null ? "" : `${corner.rowAbs ? "$" : ""}${row}`
  }`;

function refText(ref: IdRef, at: FormulaAt): string {
  const found = locate(ref, at);
  if (!found) return REF_ERROR;
  const prefix = ref.sheet === null ? "" : `${quoteSheet(found.sheet.name)}!`;
  const wholeRows = ref.from.col === null && (ref.to?.col ?? null) === null;
  const wholeCols = ref.from.row === null && (ref.to?.row ?? null) === null;
  const [r1, r2] = found.rowSpan;
  const [c1, c2] = found.colSpan;
  const from = cornerText(wholeCols ? null : r1, wholeRows ? null : c1, ref.from);
  if (!ref.to) return `${prefix}${from}`;
  return `${prefix}${from}:${cornerText(wholeCols ? null : r2, wholeRows ? null : c2, ref.to)}`;
}

function spanText(ref: SpanRef, at: FormulaAt): string {
  const first = at.doc.sheet[ref.first];
  const last = at.doc.sheet[ref.last];
  const alive = (id: string) => at.doc.sheets.some((entry) => entry.id === id && !entry.dead);
  if (!first || !last || !alive(ref.first) || !alive(ref.last)) return REF_ERROR;
  const names = `${first.name}:${last.name}`;
  const quoted =
    BARE_SHEET.test(first.name) && BARE_SHEET.test(last.name)
      ? names
      : `'${names.replaceAll("'", "''")}'`;
  return `${quoted}!${ref.area}`;
}

/** The formula as text at current positions, for the formula bar, the model and the evaluator. */
export function renderFormula(formula: Formula, at: FormulaAt): string {
  return formula.parts
    .map((part) =>
      typeof part === "string" ? part : part.k === "ref" ? refText(part, at) : spanText(part, at),
    )
    .join("");
}

/** Moves a positional area such as "B2:C9" by rows and columns; null past the grid. */
function shiftArea(area: string, rows: number, cols: number): string | null {
  const shifted = area.split(":").map((corner) => {
    const match = /^(\$?)([A-Za-z]{1,3})?(\$?)(\d{1,7})?$/.exec(corner);
    if (!match) return null;
    const [, colAbs, letters, rowAbs, digits] = match;
    let out = "";
    if (letters) {
      const col = colAbs
        ? columnIndex(letters.toUpperCase())
        : columnIndex(letters.toUpperCase()) + cols;
      if (col < 1 || col > MAX_COLUMN) return null;
      out += `${colAbs}${columnLetters(col)}`;
    }
    if (digits) {
      const absolute = letters ? rowAbs : colAbs;
      const row = absolute ? Number(digits) : Number(digits) + rows;
      if (row < 1 || row > MAX_ROW) return null;
      out += `${absolute}${row}`;
    }
    return out;
  });
  return shifted.some((corner) => corner === null) ? null : shifted.join(":");
}

/**
 * A formula read on a sheet other than its own: each reference to "this
 * sheet" names `sheet` instead, so it keeps meaning the same cells.
 */
export const qualified = (formula: Formula, sheet: string): Formula => ({
  parts: formula.parts.map((part) =>
    typeof part !== "string" && part.k === "ref" && part.sheet === null ? { ...part, sheet } : part,
  ),
});

/**
 * The formula as it reads copied from one cell to another, as fill and paste
 * copy it: relative parts shift by the distance, absolute parts stay, and a
 * reference shifted off the grid becomes #REF!. Positions are the source
 * sheet's; a part reaching past the target grid asks for growth.
 */
export function copyFormula(
  formula: Formula,
  shift: { readonly rows: number; readonly cols: number },
  at: FormulaAt,
  /** The source cell's position when pasting transposed: a relative reference's offset swaps axes. */
  transposedFrom?: { readonly row: number; readonly col: number },
): { formula: Formula } | { grow: Growth[] } {
  const grow: Growth[] = [];
  const parts = formula.parts.map((part): Formula["parts"][number] => {
    if (typeof part === "string") return part;
    if (part.k === "span") {
      const area = shiftArea(part.area, shift.rows, shift.cols);
      return area === null ? REF_ERROR : { ...part, area };
    }
    const found = locate(part, at);
    if (!found) return REF_ERROR;
    const rows = positions(found.sheet.rows);
    const cols = positions(found.sheet.cols);
    const sheetId = part.sheet ?? at.sheet;
    let off = false;
    const move = (corner: RefCorner, row: number, col: number): RefCorner => {
      const swapped =
        transposedFrom &&
        corner.row !== null &&
        corner.col !== null &&
        !corner.rowAbs &&
        !corner.colAbs;
      const nextRow = swapped
        ? transposedFrom.row + shift.rows + col - transposedFrom.col
        : corner.row === null || corner.rowAbs
          ? row
          : row + shift.rows;
      const nextCol = swapped
        ? transposedFrom.col + shift.cols + row - transposedFrom.row
        : corner.col === null || corner.colAbs
          ? col
          : col + shift.cols;
      if (nextRow < 1 || nextRow > MAX_ROW || nextCol < 1 || nextCol > MAX_COLUMN) off = true;
      if (corner.row !== null && nextRow > rows.ids.length)
        grow.push({ sheet: sheetId, rows: nextRow, cols: 0 });
      if (corner.col !== null && nextCol > cols.ids.length)
        grow.push({ sheet: sheetId, rows: 0, cols: nextCol });
      return {
        ...corner,
        row: corner.row === null ? null : (rows.ids[nextRow - 1] ?? corner.row),
        col: corner.col === null ? null : (cols.ids[nextCol - 1] ?? corner.col),
      };
    };
    const from = move(part.from, found.rowSpan[0], found.colSpan[0]);
    const to = part.to ? move(part.to, found.rowSpan[1], found.colSpan[1]) : null;
    return off ? REF_ERROR : { ...part, from, to };
  });
  if (grow.length) return { grow };
  return { formula: { parts: joinText(parts) } };
}
