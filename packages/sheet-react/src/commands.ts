import { XError, type Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import type { SheetValues } from "@chat/sheet/model/calc";
import { copyFormula, parseFormula, renderFormula } from "@chat/sheet/model/formula";
import { positions, type Axis, type Formula, type SheetDoc } from "@chat/sheet/model";
import type { CellWrite, SheetOp, StylePatch } from "@chat/sheet/model/ops";
import { parseTyped } from "@chat/sheet/value-parse";
import { cellDisplay, cellStyle } from "./display.ts";
import type { CellRef, SheetSelection } from "./grid.tsx";

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

/** Grows a working copy of the document by rows or columns at the end, minting their IDs. */
function grower(context: Pick<GridContext, "doc" | "mint">) {
  let doc = context.doc;
  const ops: SheetOp[] = [];
  return {
    get doc() {
      return doc;
    },
    ops,
    ensure(sheet: string, rows: number, cols: number) {
      for (const [axis, wanted] of [
        ["rows", rows],
        ["columns", cols],
      ] as const) {
        const entries = axis === "rows" ? doc.sheet[sheet]!.rows : doc.sheet[sheet]!.cols;
        const have = positions(entries).ids.length;
        if (wanted <= have) continue;
        const op: SheetOp = {
          op: "insert",
          sh: sheet,
          axis,
          ids: Array.from({ length: wanted - have }, context.mint),
          after: entries.at(-1)?.id ?? null,
        };
        ops.push(op);
        doc = applyChange(doc, { clientId: "local", seq: 0, ops: [op] }, 0).doc;
      }
    },
  };
}

/** A typed formula in its stored form, the grid grown first when it reaches past it. */
function typedFormula(
  text: string,
  sheet: string,
  grow: ReturnType<typeof grower>,
): Formula | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = parseFormula(text, { doc: grow.doc, sheet });
    if ("formula" in parsed) return parsed.formula;
    for (const each of parsed.grow) grow.ensure(each.sheet, each.rows, each.cols);
  }
  return null;
}

/**
 * What typing `raw` into a cell writes. A leading "=" makes a formula, an
 * apostrophe keeps text as typed, and a number typed as a percentage, a
 * currency or a date also sets that format when the cell has none.
 */
export function enterCell(context: GridContext, at: CellRef, raw: string): SheetOp[] {
  const grow = grower(context);
  const cell = context.doc.sheet[context.sheet]!.cells[at.r]?.[at.c];
  if (raw.startsWith("=") && raw.length > 1) {
    const f = typedFormula(raw.slice(1), context.sheet, grow);
    // A formula the grid cannot hold stays what was typed, as text.
    const write: CellWrite = f ? { ...at, f } : { ...at, v: raw };
    return [...grow.ops, { op: "set", sh: context.sheet, cells: [write] }];
  }
  if (raw.startsWith("'"))
    return [{ op: "set", sh: context.sheet, cells: [{ ...at, v: raw.slice(1) }] }];
  const typed = parseTyped(raw, context.locale);
  const value = typed.kind === "empty" ? null : typed.value;
  const ops: SheetOp[] = [{ op: "set", sh: context.sheet, cells: [{ ...at, v: value }] }];
  if (typed.kind === "number" && typed.format && !cellStyle(cell?.s).numberFormat)
    ops.push({
      op: "format",
      sh: context.sheet,
      area: { r1: at.r, r2: at.r, c1: at.c, c2: at.c },
      patch: { numberFormat: typed.format },
    });
  return ops;
}

/** Empties the selected cells, keeping their formats, as Delete does. */
export function clearSelection(context: GridContext): SheetOp[] {
  return [{ op: "clear", sh: context.sheet, area: selectionBox(context).area, what: "contents" }];
}

export function formatSelection(context: GridContext, patch: StylePatch): SheetOp[] {
  return [{ op: "format", sh: context.sheet, area: selectionBox(context).area, patch }];
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

/**
 * Sorts the selected rows by the active cell's column, by calculated value.
 * A selection of one cell sorts nothing; the order is worked out once here
 * and travels with the change.
 */
export function sortSelection(context: GridContext, descending: boolean): SheetOp[] {
  const box = selectionBox(context);
  if (box.rowIds.length < 2) return [];
  const by = context.selection.head.c;
  const keyed = box.rowIds.map((r, index) => ({
    r,
    index,
    value: context.values.value(context.sheet, r, by),
  }));
  keyed.sort((a, b) => {
    if (blank(a.value) !== blank(b.value)) return blank(a.value) ? 1 : -1;
    let order = rank(a.value) - rank(b.value);
    if (!order && typeof a.value === "number" && typeof b.value === "number")
      order = a.value - b.value;
    if (!order && typeof a.value === "string" && typeof b.value === "string")
      order = a.value.localeCompare(b.value, undefined, { sensitivity: "base" });
    if (!order && typeof a.value === "boolean" && typeof b.value === "boolean")
      order = Number(a.value) - Number(b.value);
    return (descending ? -order : order) || a.index - b.index;
  });
  const order = keyed.map((each) => each.r);
  if (order.every((r, index) => r === box.rowIds[index])) return [];
  return [
    {
      op: "sort",
      sh: context.sheet,
      c1: box.colIds[0]!,
      c2: box.colIds.at(-1)!,
      rows: box.rowIds,
      order,
    },
  ];
}

/** What copying the selection gives: tab-separated shown text, and the cells to paste here. */
export interface CopiedCells {
  readonly text: string;
  readonly sheet: string;
  readonly top: number;
  readonly left: number;
  readonly cells: ReadonlyArray<ReadonlyArray<{ v?: Scalar; f?: Formula }>>;
  /** Cut moves the cells when pasted, instead of copying them. */
  readonly cut: { readonly area: { r1: string; r2: string; c1: string; c2: string } } | null;
}
export function copySelection(context: GridContext, cut = false): CopiedCells {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const cells = box.rowIds.map((r) =>
    box.colIds.map((c) => {
      const cell = sheet.cells[r]?.[c];
      return cell?.f ? { f: cell.f } : { v: cell?.v ?? null };
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

/** Tab-separated text as rows of cells, quoted fields as spreadsheets write them. */
export function parseTabular(text: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (character === '"') quoted = false;
      else field += character;
    } else if (character === '"' && field === "") quoted = true;
    else if (character === "\t") {
      rows.at(-1)!.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index++;
      rows.at(-1)!.push(field);
      field = "";
      rows.push([]);
    } else field += character;
  }
  rows.at(-1)!.push(field);
  // A copied range ends with a newline; that last empty row is not data.
  if (rows.length > 1 && rows.at(-1)!.length === 1 && rows.at(-1)![0] === "") rows.pop();
  return rows;
}

/**
 * Pastes at the selection's top-left. When the clipboard holds what this
 * sheet copied, its formulas shift as a copy does, or a cut moves; anything
 * else is typed in cell by cell, as text from another program is.
 */
export function pasteAtSelection(
  context: GridContext,
  text: string,
  copied: CopiedCells | null,
): SheetOp[] {
  const box = selectionBox(context);
  const own = copied && copied.text === text ? copied : null;
  if (own?.cut)
    return [
      {
        op: "move",
        sh: own.sheet,
        box: own.cut.area,
        to: { sh: context.sheet, r: context.selection.anchor.r, c: context.selection.anchor.c },
      },
    ];
  const grid = own ? own.cells : parseTabular(text).map((row) => row.map((raw) => ({ raw })));
  const height = grid.length;
  const width = Math.max(...grid.map((row) => row.length));
  const grow = grower(context);
  grow.ensure(context.sheet, box.top + height - 1, box.left + width - 1);
  const rows = positions(grow.doc.sheet[context.sheet]!.rows).ids;
  const cols = positions(grow.doc.sheet[context.sheet]!.cols).ids;
  const cells: CellWrite[] = [];
  const formats: SheetOp[] = [];
  grid.forEach((row, y) =>
    row.forEach((item, x) => {
      const at = { r: rows[box.top - 1 + y]!, c: cols[box.left - 1 + x]! };
      if ("raw" in item) {
        const typed = enterCell({ ...context, doc: grow.doc }, at, item.raw);
        for (const op of typed)
          if (op.op === "set") cells.push(...op.cells);
          else if (op.op === "format") formats.push(op);
          else grow.ops.push(op);
        return;
      }
      if (item.f) {
        const shift = { rows: box.top - own!.top, cols: box.left - own!.left };
        const result = copyFormula(item.f, shift, { doc: grow.doc, sheet: own!.sheet });
        // On another sheet, its references are read there, as the text Excel would paste.
        const f = !("formula" in result)
          ? null
          : own!.sheet === context.sheet
            ? result.formula
            : typedFormula(
                renderFormula(result.formula, { doc: grow.doc, sheet: own!.sheet }),
                context.sheet,
                grow,
              );
        cells.push(f ? { ...at, f } : { ...at, v: "#REF!" });
      } else cells.push({ ...at, v: item.v instanceof XError ? item.v.code : (item.v ?? null) });
    }),
  );
  return [...grow.ops, { op: "set", sh: context.sheet, cells }, ...formats];
}

/** Fills the selection from its first row down, or its first column right, as Ctrl+D and Ctrl+R do. */
export function fillSelection(context: GridContext, direction: "down" | "right"): SheetOp[] {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const cells: CellWrite[] = [];
  const sources = direction === "down" ? box.colIds : box.rowIds;
  const targets = direction === "down" ? box.rowIds.slice(1) : box.colIds.slice(1);
  sources.forEach((fixed) => {
    const source =
      direction === "down" ? { r: box.rowIds[0]!, c: fixed } : { r: fixed, c: box.colIds[0]! };
    const cell = sheet.cells[source.r]?.[source.c];
    targets.forEach((moving, index) => {
      const at = direction === "down" ? { r: moving, c: fixed } : { r: fixed, c: moving };
      if (!cell?.f) {
        cells.push({ ...at, v: cell?.v ?? null });
        return;
      }
      const shift =
        direction === "down" ? { rows: index + 1, cols: 0 } : { rows: 0, cols: index + 1 };
      const result = copyFormula(cell.f, shift, { doc: context.doc, sheet: context.sheet });
      cells.push("formula" in result ? { ...at, f: result.formula } : { ...at, v: "#REF!" });
    });
  });
  return cells.length ? [{ op: "set", sh: context.sheet, cells }] : [];
}
