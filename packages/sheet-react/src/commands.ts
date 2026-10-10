import { draft, type Draft } from "@chat/sheet/model/draft";
import { cellStyle, restyle } from "@chat/sheet/model/style";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import {
  NEW_SHEET,
  liveSheets,
  positions,
  type Axis,
  type Formula,
  type SheetDoc,
} from "@chat/sheet/model";
import type { CellWrite, SheetOp, StylePatch } from "@chat/sheet/model/ops";
export type { ChartKind };
import { parseDelimited, writeDelimited } from "@chat/sheet/delimited";
import { readSource, seriesFrom, type ChartKind } from "@chat/sheet/model/chart";
import { parseTyped } from "@chat/sheet/value-parse";
import { cellDisplay, safeLink } from "./display.ts";
import { fillSeries, type FillMode, type FillPart } from "@chat/sheet/model/fill";
import type { CellRef, GridFill, SheetSelection } from "./selection.ts";

/** What a command reads: the sheet as shown, where the selection is, and a source of new IDs. */
export interface GridContext {
  readonly doc: SheetDoc;
  readonly sheet: string;
  readonly selection: SheetSelection;
  readonly values: SheetValues;
  readonly locale: SheetLocale;
  readonly mint: () => string;
}

/** A selection's rectangle as positions (from 1) and IDs. */
export function selectionBox(context: Pick<GridContext, "doc" | "sheet" | "selection">) {
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const at = (ref: CellRef) => ({ row: rows.at(ref.r) ?? 1, col: cols.at(ref.c) ?? 1 });
  const [a, b] = [at(context.selection.anchor), at(context.selection.head)];
  const box = {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.col, b.col),
    right: Math.max(a.col, b.col),
  };
  const rowIds = rows.ids.slice(box.top - 1, box.bottom);
  const colIds = cols.ids.slice(box.left - 1, box.right);
  return {
    ...box,
    rowIds,
    colIds,
    area: { r1: rowIds[0]!, r2: rowIds.at(-1)!, c1: colIds[0]!, c2: colIds.at(-1)! },
  };
}

/** Each selected range as a selection of its own, the active one last. */
export function rangesOf(context: Pick<GridContext, "selection">): SheetSelection[] {
  const { anchor, head, more = [] } = context.selection;
  return [...more.map((range) => ({ anchor: range.anchor, head: range.head })), { anchor, head }];
}

/** A command run on every selected range, as Excel formats or clears several at once. */
export function eachRange(
  context: GridContext,
  command: (context: GridContext) => SheetOp[],
): SheetOp[] {
  return rangesOf(context).flatMap((selection) => command({ ...context, selection }));
}

/**
 * What typing `raw` into a cell writes. A leading "=" makes a formula, an
 * apostrophe keeps text as typed, and a number typed as a percentage, a
 * currency or a date also sets that format when the cell has none.
 */
/** The link a typed address stands for: a web address, one starting www., or a mail address. */
function typedLink(text: string): string | null {
  if (/\s/.test(text) || text.length > 2000) return null;
  if (/^https?:\/\/[^/]+\.\S+$/i.test(text) || /^https?:\/\/localhost\b/i.test(text))
    return safeLink(text);
  if (/^www\.[^.]+\.\S+$/i.test(text)) return safeLink(`https://${text}`);
  if (/^[^@/:]+@[^@/:]+\.[a-z]{2,}$/i.test(text)) return safeLink(`mailto:${text}`);
  return null;
}

export function enterCell(context: GridContext, at: CellRef, raw: string): SheetOp[] {
  const grow = draft(context.doc, context.mint);
  const ops = typeInto(context.sheet, at, raw, grow, context.locale);
  return [...grow.ops, ...ops];
}

/** What typing writes, less the growth it needs, which goes into `grow` for the caller to send first. */
function typeInto(
  sheet: string,
  at: CellRef,
  raw: string,
  grow: Draft,
  locale: GridContext["locale"],
): SheetOp[] {
  const context = { sheet, locale };
  const cell = grow.doc.sheet[sheet]!.cells[at.r]?.[at.c];
  if (raw.startsWith("=") && raw.length > 1) {
    const f = grow.formula(raw.slice(1), context.sheet);
    // A formula the grid cannot hold stays what was typed, as text.
    const write: CellWrite = f ? { ...at, f } : { ...at, v: raw };
    return [{ op: "set", sh: context.sheet, cells: [write] }];
  }
  if (raw.startsWith("'"))
    return [{ op: "set", sh: context.sheet, cells: [{ ...at, v: raw.slice(1) }] }];
  const typed = parseTyped(raw, context.locale);
  const value = typed.kind === "empty" ? null : typed.value;
  const ops: SheetOp[] = [{ op: "set", sh: context.sheet, cells: [{ ...at, v: value }] }];
  const area = { r1: at.r, r2: at.r, c1: at.c, c2: at.c };
  if (typed.kind === "number" && typed.format && !cellStyle(cell?.s).numberFormat)
    ops.push({ op: "format", sh: context.sheet, area, patch: { numberFormat: typed.format } });
  // A web or mail address typed in becomes a link, as Excel's AutoCorrect makes one.
  const link =
    typeof value === "string" && !cellStyle(cell?.s).link ? typedLink(value.trim()) : null;
  if (link) ops.push({ op: "format", sh: context.sheet, area, patch: { link } });
  // A line break typed in turns on wrapping, so it shows, as Excel does.
  if (typeof value === "string" && value.includes("\n") && !cellStyle(cell?.s).wrap)
    ops.push({ op: "format", sh: context.sheet, area, patch: { wrap: true } });
  return ops;
}

/**
 * What was typed, written into every selected cell as Ctrl+Enter does: a
 * formula is read at the active cell and shifted to each other one.
 */
export function enterSelection(context: GridContext, raw: string): SheetOp[] {
  const head = context.selection.head;
  const grow = draft(context.doc, context.mint);
  const typed = typeInto(context.sheet, head, raw, grow, context.locale);
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const [headRow, headCol] = [rows.at(head.r) ?? box.top, cols.at(head.c) ?? box.left];
  const written = typed.flatMap((op): SheetOp[] => {
    if (op.op === "format") return [{ ...op, area: box.area }];
    if (op.op !== "set") return [op];
    const typedCell = op.cells[0]!;
    const cells = box.rowIds.flatMap((r, y) =>
      box.colIds.map((c, x): CellWrite => {
        if (!typedCell.f) return { r, c, v: typedCell.v ?? null };
        const shift = { rows: box.top + y - headRow, cols: box.left + x - headCol };
        const f = grow.copy(typedCell.f, shift, context.sheet);
        return f ? { r, c, f } : { r, c, v: "#REF!" };
      }),
    );
    return [{ ...op, cells }];
  });
  // Growth for the typed formula and for each copy of it, before the writes that need it.
  return [...grow.ops, ...written];
}

/** Empties the selected cells, keeping their formats, as Delete does. */
export function clearSelection(context: GridContext): SheetOp[] {
  return [{ op: "clear", sh: context.sheet, area: selectionBox(context).area, what: "contents" }];
}

export function formatSelection(context: GridContext, patch: StylePatch): SheetOp[] {
  return [{ op: "format", sh: context.sheet, area: selectionBox(context).area, patch }];
}

/** Hides the selection's rows or columns, or shows again the hidden ones it spans. */
export function hideAtSelection(context: GridContext, axis: Axis, hidden: boolean): SheetOp[] {
  const box = selectionBox(context);
  const ids = axis === "rows" ? box.rowIds : box.colIds;
  const props = context.doc.sheet[context.sheet]![axis === "rows" ? "rowProps" : "colProps"];
  // Showing again touches only what is hidden; hiding, everything selected.
  const touched = hidden ? ids : ids.filter((id) => props[id]?.hidden);
  return touched.length ? [{ op: "hide", sh: context.sheet, axis, ids: touched, hidden }] : [];
}

/** As many new rows or columns as are selected, before or after them. */
export function insertAtSelection(
  context: GridContext,
  axis: Axis,
  side: "before" | "after",
): SheetOp[] {
  const box = selectionBox(context);
  const ids = axis === "rows" ? box.rowIds : box.colIds;
  const sheet = context.doc.sheet[context.sheet]!;
  const all = positions(axis === "rows" ? sheet.rows : sheet.cols).ids;
  const first = axis === "rows" ? box.top : box.left;
  const after = side === "after" ? ids.at(-1)! : first > 1 ? all[first - 2]! : null;
  return [
    {
      op: "insert",
      sh: context.sheet,
      axis,
      ids: Array.from({ length: ids.length }, context.mint),
      after,
    },
  ];
}

/** Deletes the selected rows or columns, unless that would leave none. */
export function deleteAtSelection(context: GridContext, axis: Axis): SheetOp[] {
  const box = selectionBox(context);
  const ids = axis === "rows" ? box.rowIds : box.colIds;
  const sheet = context.doc.sheet[context.sheet]!;
  if (ids.length >= positions(axis === "rows" ? sheet.rows : sheet.cols).ids.length) return [];
  return [{ op: "delete", sh: context.sheet, axis, ids }];
}

/** Excel's ascending order: numbers, text, logicals, errors; blanks always last. */
const rank = (value: Scalar) =>
  typeof value === "number"
    ? 0
    : typeof value === "string"
      ? 1
      : typeof value === "boolean"
        ? 2
        : value instanceof XError
          ? 3
          : 4;
const blank = (value: Scalar) => value === null || value === "";

/** Two values in sort order; `fixed` marks a blank, which goes last whichever way. */
const compare = (a: Scalar, b: Scalar) => {
  if (blank(a) !== blank(b)) return { order: blank(a) ? 1 : -1, fixed: true };
  let order = rank(a) - rank(b);
  if (!order && typeof a === "number" && typeof b === "number") order = a - b;
  if (!order && typeof a === "string" && typeof b === "string")
    order = a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
  if (!order && typeof a === "boolean" && typeof b === "boolean") order = Number(a) - Number(b);
  return { order, fixed: false };
};

/** One column to sort by, and which way. */
export interface SortKey {
  readonly column: string;
  readonly descending: boolean;
}

/**
 * Rows reordered by several columns in turn, as Excel's Sort dialog does:
 * numbers, then text, then true/false, errors after, blanks last whichever
 * way. The order is worked out once here and travels with the change.
 */
export function sortRows(
  context: Pick<GridContext, "sheet" | "values">,
  rows: readonly string[],
  columns: { readonly c1: string; readonly c2: string },
  keys: readonly SortKey[],
): SheetOp[] {
  if (rows.length < 2 || !keys.length) return [];
  const value = (r: string, c: string) => context.values.value(context.sheet, r, c);
  const order = rows
    .map((r, index) => ({ r, index }))
    .toSorted((a, b) => {
      for (const key of keys) {
        const { order: found, fixed } = compare(value(a.r, key.column), value(b.r, key.column));
        // Blanks go last either way, as in Excel.
        if (found) return fixed || !key.descending ? found : -found;
      }
      return a.index - b.index;
    })
    .map((each) => each.r);
  if (order.every((r, index) => r === rows[index])) return [];
  return [{ op: "sort", sh: context.sheet, ...columns, rows, order }];
}

/** Sorts the selected rows by the active cell's column, as the A to Z buttons do. */
export function sortSelection(context: GridContext, descending: boolean): SheetOp[] {
  const box = selectionBox(context);
  return sortRows(context, box.rowIds, { c1: box.colIds[0]!, c2: box.colIds.at(-1)! }, [
    { column: context.selection.head.c, descending },
  ]);
}

/** A copied cell: what it holds, what it showed, and its style key. */
export interface CopiedCell {
  readonly v?: Scalar;
  readonly f?: Formula;
  /** Its value when copied, which Paste Values writes. */
  readonly value: Scalar;
  readonly s?: string;
}
/** What copying the selection gives: tab-separated shown text, and the cells to paste here. */
export interface CopiedCells {
  readonly text: string;
  readonly sheet: string;
  readonly top: number;
  readonly left: number;
  readonly cells: ReadonlyArray<ReadonlyArray<CopiedCell>>;
  /** Cut moves the cells when pasted, instead of copying them. */
  readonly cut: { readonly area: { r1: string; r2: string; c1: string; c2: string } } | null;
}
export function copySelection(context: GridContext, cut = false): CopiedCells {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const cells = box.rowIds.map((r) =>
    box.colIds.map((c): CopiedCell => {
      const cell = sheet.cells[r]?.[c];
      const value = context.values.value(context.sheet, r, c);
      return {
        ...(cell?.f ? { f: cell.f } : { v: cell?.v ?? null }),
        value,
        ...(cell?.s ? { s: cell.s } : {}),
      };
    }),
  );
  const text = box.rowIds
    .map((r) =>
      box.colIds
        .map((c) => {
          const shown = cellDisplay(
            context.values.value(context.sheet, r, c),
            cellStyle(sheet.cells[r]?.[c]?.s),
            context.locale,
          ).text;
          return /[\t\n"]/.test(shown) ? `"${shown.replaceAll('"', '""')}"` : shown;
        })
        .join("\t"),
    )
    .join("\n");
  return {
    text,
    sheet: context.sheet,
    top: box.top,
    left: box.left,
    cells,
    cut: cut ? { area: box.area } : null,
  };
}

/**
 * How far a sheet's values reach, as 1-based last row and column: every cell
 * holding one, and every cell a formula spills into. Zero when none does.
 */
export function usedExtent(
  context: Pick<GridContext, "doc" | "values">,
  sheetId: string,
): { bottom: number; right: number } {
  const sheet = context.doc.sheet[sheetId]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  let [bottom, right] = [0, 0];
  const reach = (r: string, c: string) => {
    bottom = Math.max(bottom, rows.at(r) ?? 0);
    right = Math.max(right, cols.at(c) ?? 0);
  };
  for (const [r, row] of Object.entries(sheet.cells))
    for (const [c, cell] of Object.entries(row)) {
      if (context.values.value(sheetId, r, c) !== null) reach(r, c);
      const spill = cell.f ? context.values.spill(sheetId, r, c) : null;
      if (spill?.rows.length && spill.cols.length) reach(spill.rows.at(-1)!, spill.cols.at(-1)!);
    }
  return { bottom, right };
}

/**
 * A sheet as CSV, as Excel saves one: each cell's shown text over the range
 * holding values, hidden rows and columns included.
 */
export function sheetCsv(
  context: Pick<GridContext, "doc" | "values" | "locale">,
  sheetId: string,
): string {
  const sheet = context.doc.sheet[sheetId]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const { bottom, right } = usedExtent(context, sheetId);
  const grid = rows.ids.slice(0, bottom).map((r) =>
    cols.ids.slice(0, right).map((c) => {
      const value = context.values.value(sheetId, r, c);
      return value instanceof XError
        ? value.code
        : cellDisplay(value, cellStyle(sheet.cells[r]?.[c]?.s), context.locale).text;
    }),
  );
  return writeDelimited(grid, ",");
}

/** Tab-separated text as rows of cells, as spreadsheets put it on the clipboard. */
export const parseTabular = (text: string) => parseDelimited(text, "\t");

/** A cell from another program: text typed in as if entered, and the style it carried. */
export interface ForeignCell {
  readonly raw: string;
  /** The number it holds, where its program marked one, written as it is. */
  readonly value?: number;
  readonly style?: StylePatch;
}
/** What a paste writes, as Excel's Paste Special: everything, values, formulas or formats. */
export type PastePart = "all" | "values" | "formulas" | "formats";

/**
 * Pastes at the selection's top-left. When the clipboard holds what this
 * sheet copied, its formulas shift as a copy does, or a cut moves, and its
 * formats come along; anything else is typed in cell by cell, with the
 * styles `foreign` read from the clipboard's HTML. Transposing swaps rows
 * and columns.
 */
export function pasteAtSelection(
  context: GridContext,
  text: string,
  copied: CopiedCells | null,
  options: {
    readonly part?: PastePart;
    readonly transpose?: boolean;
    readonly foreign?: ReadonlyArray<ReadonlyArray<ForeignCell>> | null;
  } = {},
): SheetOp[] {
  const { part = "all", transpose = false } = options;
  const box = selectionBox(context);
  const own = copied && copied.text === text ? copied : null;
  if (own?.cut && part === "all" && !transpose)
    return [
      {
        op: "move",
        sh: own.sheet,
        box: own.cut.area,
        to: { sh: context.sheet, r: context.selection.anchor.r, c: context.selection.anchor.c },
      },
    ];
  const read: ReadonlyArray<ReadonlyArray<CopiedCell | ForeignCell>> = own
    ? own.cells
    : (options.foreign ?? parseTabular(text).map((row) => row.map((raw) => ({ raw }))));
  const grid = transpose
    ? Array.from({ length: Math.max(...read.map((row) => row.length)) }, (_, x) =>
        read.map((row) => row[x] ?? { raw: "" }),
      )
    : read;
  const height = grid.length;
  const width = Math.max(...grid.map((row) => row.length));
  const grow = draft(context.doc, context.mint);
  grow.ensure(context.sheet, box.top + height - 1, box.left + width - 1);
  const target = grow.doc.sheet[context.sheet]!;
  const rows = positions(target.rows).ids;
  const cols = positions(target.cols).ids;
  const cells: CellWrite[] = [];
  const typedFormats: SheetOp[] = [];
  const styles: SheetOp[] = [];
  grid.forEach((row, y) =>
    row.forEach((item, x) => {
      const at = { r: rows[box.top - 1 + y]!, c: cols[box.left - 1 + x]! };
      const area = { r1: at.r, r2: at.r, c1: at.c, c2: at.c };
      if (part === "all" || part === "formats") {
        const wanted =
          "raw" in item ? (options.foreign ? (item.style ?? {}) : null) : cellStyle(item.s);
        const patch = wanted && restyle(target.cells[at.r]?.[at.c]?.s, wanted);
        if (patch) styles.push({ op: "format", sh: context.sheet, area, patch });
      }
      if (part === "formats") return;
      if ("raw" in item && item.value !== undefined) {
        cells.push({ ...at, v: item.value });
        return;
      }
      if ("raw" in item) {
        for (const op of typeInto(context.sheet, at, item.raw, grow, context.locale))
          if (op.op === "set") cells.push(...op.cells);
          else typedFormats.push(op);
        return;
      }
      if (part === "values" || !item.f) {
        const value = part === "values" ? item.value : (item.v ?? null);
        cells.push({ ...at, v: value instanceof XError ? value.code : value });
        return;
      }
      // Each formula moves by as far as its own cell did; transposed, its references turn too.
      const [fromRow, fromCol] = transpose ? [x, y] : [y, x];
      const shift = {
        rows: box.top + y - (own!.top + fromRow),
        cols: box.left + x - (own!.left + fromCol),
      };
      const pasted = grow.copy(
        item.f,
        shift,
        own!.sheet,
        transpose ? { row: own!.top + fromRow, col: own!.left + fromCol } : undefined,
      );
      // On another sheet, its references are read there, as the text Excel would paste.
      const f =
        !pasted || own!.sheet === context.sheet
          ? pasted
          : grow.formula(
              renderFormula(pasted, { doc: grow.doc, sheet: own!.sheet }),
              context.sheet,
            );
      cells.push(f ? { ...at, f } : { ...at, v: "#REF!" });
    }),
  );
  return [
    ...grow.ops,
    ...(cells.length ? [{ op: "set" as const, sh: context.sheet, cells }] : []),
    ...typedFormats,
    ...styles,
  ];
}

/**
 * Fills the selection from its first row down, or its first column right, as
 * Ctrl+D and Ctrl+R do: each cell copied whole, its format and link too.
 */
export function fillSelection(context: GridContext, direction: "down" | "right"): SheetOp[] {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const grow = draft(context.doc, context.mint);
  const cells: CellWrite[] = [];
  const formats: SheetOp[] = [];
  const sources = direction === "down" ? box.colIds : box.rowIds;
  const targets = direction === "down" ? box.rowIds.slice(1) : box.colIds.slice(1);
  for (const fixed of sources) {
    const source =
      direction === "down" ? { r: box.rowIds[0]!, c: fixed } : { r: fixed, c: box.colIds[0]! };
    const cell = sheet.cells[source.r]?.[source.c];
    const style = cellStyle(cell?.s);
    for (const [index, moving] of targets.entries()) {
      const at = direction === "down" ? { r: moving, c: fixed } : { r: fixed, c: moving };
      const patch = restyle(sheet.cells[at.r]?.[at.c]?.s, style);
      if (patch)
        formats.push({
          op: "format",
          sh: context.sheet,
          area: { r1: at.r, r2: at.r, c1: at.c, c2: at.c },
          patch,
        });
      if (!cell?.f) {
        cells.push({ ...at, v: cell?.v ?? null });
        continue;
      }
      const shift =
        direction === "down" ? { rows: index + 1, cols: 0 } : { rows: 0, cols: index + 1 };
      const f = grow.copy(cell.f, shift, context.sheet);
      cells.push(f ? { ...at, f } : { ...at, v: "#REF!" });
    }
  }
  return [
    ...grow.ops,
    ...(cells.length ? [{ op: "set" as const, sh: context.sheet, cells }] : []),
    ...formats,
  ];
}

/** Whether dropping the selection this far away would write over cells holding something. */
export function dragOverwrites(
  context: GridContext,
  shift: { readonly rows: number; readonly cols: number },
): boolean {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows).ids;
  const cols = positions(sheet.cols).ids;
  const top = Math.max(1, box.top + shift.rows);
  const left = Math.max(1, box.left + shift.cols);
  for (let row = top; row <= top + box.bottom - box.top; row++)
    for (let col = left; col <= left + box.right - box.left; col++) {
      // The selection's own cells are moving away, so they are not overwritten.
      if (row >= box.top && row <= box.bottom && col >= box.left && col <= box.right) continue;
      const cell =
        rows[row - 1] && cols[col - 1] ? sheet.cells[rows[row - 1]!]?.[cols[col - 1]!] : undefined;
      if (cell?.f || (cell?.v !== undefined && cell.v !== null)) return true;
    }
  return false;
}

/**
 * The selection dragged by its border `rows` down and `cols` right: moved, as
 * a cut and paste would, or copied with its formats when Alt or Ctrl was held.
 */
export function dragSelection(
  context: GridContext,
  shift: { readonly rows: number; readonly cols: number },
  copy: boolean,
): { ops: SheetOp[]; selection: SheetSelection } | null {
  const box = selectionBox(context);
  const top = Math.max(1, box.top + shift.rows);
  const left = Math.max(1, box.left + shift.cols);
  if (top === box.top && left === box.left) return null;
  const height = box.bottom - box.top;
  const width = box.right - box.left;
  const grow = draft(context.doc, context.mint);
  grow.ensure(context.sheet, top + height, left + width);
  const rows = positions(grow.doc.sheet[context.sheet]!.rows).ids;
  const cols = positions(grow.doc.sheet[context.sheet]!.cols).ids;
  const to = { r: rows[top - 1]!, c: cols[left - 1]! };
  const selection = {
    anchor: to,
    head: { r: rows[top + height - 1]!, c: cols[left + width - 1]! },
  };
  if (!copy)
    return {
      ops: [...grow.ops, { op: "move", sh: context.sheet, box: box.area, to }],
      selection,
    };
  const sheet = grow.doc.sheet[context.sheet]!;
  const cells: CellWrite[] = [];
  const formats: SheetOp[] = [];
  box.rowIds.forEach((r, y) =>
    box.colIds.forEach((c, x) => {
      const cell = sheet.cells[r]?.[c];
      const at = { r: rows[top - 1 + y]!, c: cols[left - 1 + x]! };
      if (cell?.f) {
        const by = { rows: top - box.top, cols: left - box.left };
        const f = grow.copy(cell.f, by, context.sheet);
        cells.push(f ? { ...at, f } : { ...at, v: "#REF!" });
      } else cells.push({ ...at, v: cell?.v ?? null });
      const patch = restyle(sheet.cells[at.r]?.[at.c]?.s, cellStyle(cell?.s));
      if (patch)
        formats.push({
          op: "format",
          sh: context.sheet,
          area: { r1: at.r, r2: at.r, c1: at.c, c2: at.c },
          patch,
        });
    }),
  );
  return { ops: [...grow.ops, { op: "set", sh: context.sheet, cells }, ...formats], selection };
}

/**
 * What a fill handle drag writes, and the selection grown to cover it. A
 * double-click fills down as far as the column beside the selection holds
 * values, the left one first, as Excel does.
 */
export function fillFromHandle(
  context: GridContext,
  fill: Omit<GridFill, "mode"> & { readonly mode: FillMode },
  part: FillPart = "all",
): { ops: SheetOp[]; selection: SheetSelection; count: number } | null {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows).ids;
  const cols = positions(sheet.cols).ids;
  let count = fill.count;
  if (count === "auto") {
    const filled = (col: number) => {
      const c = cols[col - 1];
      if (!c) return 0;
      let row = box.bottom + 1;
      while (row <= rows.length && context.values.value(context.sheet, rows[row - 1]!, c) !== null)
        row++;
      return row - box.bottom - 1;
    };
    count = filled(box.left - 1) || filled(box.right + 1);
  }
  if (count < 0) {
    // Dragged back in: the last rows or columns are cleared, the rest stays selected.
    const keep =
      fill.direction === "down"
        ? { r: box.rowIds[Math.max(0, box.rowIds.length + count - 1)]!, c: box.colIds.at(-1)! }
        : { r: box.rowIds.at(-1)!, c: box.colIds[Math.max(0, box.colIds.length + count - 1)]! };
    const cleared =
      fill.direction === "down"
        ? { ...box.area, r1: box.rowIds[box.rowIds.length + count]! }
        : { ...box.area, c1: box.colIds[box.colIds.length + count]! };
    return {
      ops: [{ op: "clear", sh: context.sheet, area: cleared, what: "contents" }],
      selection: { anchor: { r: box.area.r1, c: box.area.c1 }, head: keep },
      count,
    };
  }
  if (count < 1) return null;
  const grow = draft(context.doc, context.mint);
  if (fill.direction === "down") grow.ensure(context.sheet, box.bottom + count, box.right);
  if (fill.direction === "right") grow.ensure(context.sheet, box.bottom, box.right + count);
  const ops = fillSeries(
    grow.doc,
    context.sheet,
    box.area,
    fill.direction,
    count,
    fill.mode,
    context.locale,
    part,
    (formula, shift) => grow.copy(formula, shift, context.sheet),
  );
  if (!ops.length) return null;
  const grown = grow.doc.sheet[context.sheet]!;
  const allRows = positions(grown.rows).ids;
  const allCols = positions(grown.cols).ids;
  const [top, bottom, left, right] =
    fill.direction === "down"
      ? [box.top, box.bottom + count, box.left, box.right]
      : fill.direction === "up"
        ? [Math.max(1, box.top - count), box.bottom, box.left, box.right]
        : fill.direction === "right"
          ? [box.top, box.bottom, box.left, box.right + count]
          : [box.top, box.bottom, Math.max(1, box.left - count), box.right];
  return {
    ops: [...grow.ops, ...ops],
    selection: {
      anchor: { r: allRows[top - 1]!, c: allCols[left - 1]! },
      head: { r: allRows[bottom - 1]!, c: allCols[right - 1]! },
    },
    count,
  };
}

/**
 * A chart of the selection, read as Excel reads a range (`readSource`) and
 * placed to the right of it. Nothing to chart in one cell.
 */
export function chartFromSelection(context: GridContext, kind: ChartKind): SheetOp[] {
  const box = selectionBox(context);
  if (box.rowIds.length < 2 && box.colIds.length < 2) return [];
  const source = readSource(context.doc, context.values, context.sheet, box.area);
  const series = seriesFrom(context.doc, source, kind, context.values);
  if (!series.length) return [];
  const grow = draft(context.doc, context.mint);
  grow.ensure(context.sheet, box.top, box.right + 2);
  const cols = positions(grow.doc.sheet[context.sheet]!.cols).ids;
  return [
    ...grow.ops,
    {
      op: "chartPut",
      id: context.mint(),
      chart: {
        sheet: context.sheet,
        kind,
        at: { r: box.rowIds[0]!, c: cols[box.right + 1]! },
        size: { width: 480, height: 300 },
        // One series needs no legend; a pie's legend names its slices.
        legend: series.length > 1 || kind === "pie" || kind === "doughnut" ? "bottom" : "none",
        series,
        source,
      },
    },
  ];
}

/** A name for a new sheet that no live sheet has: Sheet2, Sheet3 and on. */
const nextSheetName = (names: readonly string[]) => {
  const taken = new Set(names.map((name) => name.toLowerCase()));
  for (let n = names.length + 1; ; n++) if (!taken.has(`sheet${n}`)) return `Sheet${n}`;
};

/** A new empty sheet after the last, named as Excel names the next one. */
export function newSheet(doc: SheetDoc, id: string): SheetOp {
  const sheets = liveSheets(doc);
  return {
    op: "sheetAdd",
    id,
    name: nextSheetName(sheets.map((each) => doc.sheet[each]!.name)),
    after: sheets.at(-1) ?? null,
    rows: Array.from({ length: NEW_SHEET.rows }, (_, n) => `${id}.r${n + 1}`),
    cols: Array.from({ length: NEW_SHEET.cols }, (_, n) => `${id}.c${n + 1}`),
  };
}
