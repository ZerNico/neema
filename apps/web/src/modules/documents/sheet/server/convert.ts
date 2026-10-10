import { columnLetters, parseCell, parseRange } from "@chat/sheet/a1";
import type { Scalar } from "@chat/sheet/engine/evaluate";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { copyFormula, parseFormula, quoteSheet, renderFormula } from "@chat/sheet/model/formula";
import { LIVE_LIMITS } from "@chat/sheet/model/limits";
import {
  NEW_SHEET,
  liveSheets,
  positions,
  sheetNamed,
  type Axis,
  type Cell,
  type Formula,
  type SheetDoc,
} from "@chat/sheet/model";
import type { CellWrite, SheetOp, StylePatch } from "@chat/sheet/model/ops";
import type { CellInput } from "~/modules/spreadsheets/operations.ts";
import type { LiveSheetOperation } from "../live-operations.ts";

export interface ConvertInput {
  readonly doc: SheetDoc;
  /** The revision of this sheet the model last saw. */
  readonly seen: number;
  /** Revisions this answer wrote itself, which are never someone else's edits. */
  readonly own: ReadonlySet<number>;
  /** An ID nobody else mints. */
  readonly mint: () => string;
  /** What volatile functions read, for sorting by calculated values. */
  readonly context: CalcContext;
}
export type Converted =
  | { ok: true; ops: SheetOp[]; doc: SheetDoc }
  | { ok: false; outcome: "conflict" | "not_found" | "invalid"; message: string };

class Refused extends Error {
  constructor(
    readonly outcome: "conflict" | "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
/** Writes in the private view carry this revision, so the guards count them as the call's own. */
const WORKING = -1;

/** Excel's sort order: numbers, text, logicals, errors, then blanks. */
const rank = (value: Scalar) =>
  value === null || value === ""
    ? 4
    : typeof value === "number"
      ? 0
      : typeof value === "string"
        ? 1
        : typeof value === "boolean"
          ? 2
          : 3;
const compare = (a: Scalar, b: Scalar) => {
  const ranked = rank(a) - rank(b);
  if (ranked) return ranked;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string")
    return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return 0;
};
const blank = (value: Scalar) => value === null || value === "";
const corner = (row: number, col: number) => `$${columnLetters(col)}$${row}`;
const span = (text: string) => {
  const [from = "", to = from] = text.split(":");
  return { from, to };
};

/**
 * Turns one call's operations into ID changes, each resolved against what
 * the ones before it made: a sheet added then written, rows inserted then
 * filled. Nothing applies when one is refused. Overwriting or deleting cells
 * someone else changed since the model's view is a conflict.
 */
export function convertOperations(
  input: ConvertInput,
  operations: readonly LiveSheetOperation[],
): Converted {
  let view = input.doc;
  const out: SheetOp[] = [];
  const emit = (...ops: SheetOp[]) => {
    out.push(...ops);
    view = applyChange(view, { clientId: "convert", seq: 1, ops }, WORKING).doc;
  };

  const sheetId = (name: string) => {
    const id = sheetNamed(view, name);
    if (id) return id;
    const names = liveSheets(view).map((each) => view.sheet[each]!.name);
    throw new Refused("not_found", `No sheet named ${name}. Sheets: ${names.join(", ")}.`);
  };
  const ids = (sh: string, axis: Axis) =>
    positions(axis === "rows" ? view.sheet[sh]!.rows : view.sheet[sh]!.cols).ids;
  /** Grows a sheet's grid to at least this many rows and columns. */
  const ensure = (sh: string, rows: number, cols: number) => {
    for (const [axis, wanted, limit] of [
      ["rows", rows, LIVE_LIMITS.rows],
      ["columns", cols, LIVE_LIMITS.cols],
    ] as const) {
      const have = ids(sh, axis).length;
      if (wanted <= have) continue;
      const entries = axis === "rows" ? view.sheet[sh]!.rows : view.sheet[sh]!.cols;
      if (entries.length + wanted - have > limit)
        throw new Refused("invalid", `A live sheet holds at most ${limit} ${axis}.`);
      emit({
        op: "insert",
        sh,
        axis,
        ids: Array.from({ length: wanted - have }, input.mint),
        after: entries.at(-1)?.id ?? null,
      });
    }
  };
  const label = (sh: string, r: string, c: string) =>
    `${quoteSheet(view.sheet[sh]!.name)}!${columnLetters(positions(view.sheet[sh]!.cols).at(c) ?? 0)}${positions(view.sheet[sh]!.rows).at(r) ?? 0}`;
  const changedSince = (cell: Cell | undefined) =>
    !!cell && cell.w > input.seen && !input.own.has(cell.w);
  /** Refuses touching cells someone else changed since the model's view. */
  const guard = (
    sh: string,
    rows: ReadonlySet<string> | null,
    cols: ReadonlySet<string> | null,
  ) => {
    for (const [r, row] of Object.entries(view.sheet[sh]!.cells)) {
      if (rows && !rows.has(r)) continue;
      for (const [c, cell] of Object.entries(row))
        if ((!cols || cols.has(c)) && changedSince(cell))
          throw new Refused(
            "conflict",
            `${label(sh, r, c)} changed since your view of the sheet. Nothing was applied; the view now shows it, so check it and send the call again.`,
          );
    }
  };
  /** A range's row and column IDs, the grid grown to hold it. */
  const area = (sh: string, text: string) => {
    const box = parseRange(text)!;
    ensure(sh, box.bottom, box.right);
    const rows = ids(sh, "rows").slice(box.top - 1, box.bottom);
    const cols = ids(sh, "columns").slice(box.left - 1, box.right);
    return {
      box,
      rows,
      cols,
      ids: { r1: rows[0]!, r2: rows.at(-1)!, c1: cols[0]!, c2: cols.at(-1)! },
    };
  };
  const formula = (text: string, sh: string): Formula => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const parsed = parseFormula(text, { doc: view, sheet: sh });
      if ("formula" in parsed) return parsed.formula;
      for (const growth of parsed.grow) ensure(growth.sheet, growth.rows, growth.cols);
    }
    throw new Refused("invalid", `=${text.slice(0, 80)} reaches past what a live sheet holds.`);
  };
  /** A formula copied by a distance, its references then read on the target sheet. */
  const copied = (f: Formula, from: string, to: string, shift: { rows: number; cols: number }) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = copyFormula(f, shift, { doc: view, sheet: from });
      if ("formula" in result)
        return from === to
          ? result.formula
          : formula(renderFormula(result.formula, { doc: view, sheet: from }), to);
      for (const growth of result.grow) ensure(growth.sheet, growth.rows, growth.cols);
    }
    throw new Refused("invalid", "A copied formula reaches past what a live sheet holds.");
  };
  const write = (r: string, c: string, value: CellInput, sh: string): CellWrite => {
    if (typeof value === "string" && value.startsWith("="))
      return { r, c, f: formula(value.slice(1), sh) };
    if (typeof value === "string" && value.startsWith("'")) return { r, c, v: value.slice(1) };
    return { r, c, v: value };
  };
  const axisIds = (sh: string, axis: Axis, text: string) => {
    const { from, to } = span(text);
    const index = (part: string) =>
      axis === "rows" ? Number(part) : parseCell(`${part}1`)!.column;
    const [first, last] = [index(from), index(to)].toSorted((a, b) => a - b) as [number, number];
    return { first, last, ids: () => ids(sh, axis).slice(first - 1, last) };
  };

  const one = (operation: LiveSheetOperation) => {
    switch (operation.kind) {
      case "setCells": {
        const sh = sheetId(operation.sheet);
        const start = parseCell(operation.start)!;
        const width = Math.max(...operation.rows.map((row) => row.length));
        ensure(sh, start.row + operation.rows.length - 1, start.column + width - 1);
        const rows = ids(sh, "rows");
        const cols = ids(sh, "columns");
        const targets = operation.rows.flatMap((row, y) =>
          row.map((value, x) => ({
            r: rows[start.row - 1 + y]!,
            c: cols[start.column - 1 + x]!,
            value,
          })),
        );
        guard(sh, new Set(targets.map((each) => each.r)), new Set(targets.map((each) => each.c)));
        // A formula may grow the grid, so writes are built before any is emitted.
        const cells = targets.map((each) => write(each.r, each.c, each.value, sh));
        emit({ op: "set", sh, cells });
        return;
      }
      case "clearRange": {
        const sh = sheetId(operation.sheet);
        const { rows, cols, ids: box } = area(sh, operation.range);
        guard(sh, new Set(rows), new Set(cols));
        emit({ op: "clear", sh, area: box, what: "contents" });
        return;
      }
      case "setFormat": {
        const sh = sheetId(operation.sheet);
        const { ids: whole, rows, cols } = area(sh, operation.range);
        const patch: Record<string, string | number | boolean | null> = {};
        for (const key of [
          "bold",
          "italic",
          "fontSize",
          "fontColor",
          "horizontal",
          "vertical",
          "wrap",
        ] as const)
          if (operation[key] !== undefined) patch[key] = operation[key];
        if (operation.fill !== undefined)
          patch.fill = operation.fill === "none" ? null : operation.fill;
        if (operation.numberFormat !== undefined)
          patch.numberFormat =
            operation.numberFormat.toLowerCase() === "general" ? null : operation.numberFormat;
        const formats: Array<{ area: typeof whole; patch: StylePatch }> = [];
        if (Object.keys(patch).length) formats.push({ area: whole, patch });
        const edges = { borderTop: true, borderBottom: true, borderLeft: true, borderRight: true };
        if (operation.border === "all") formats.push({ area: whole, patch: edges });
        if (operation.border === "none")
          formats.push({
            area: whole,
            patch: { borderTop: null, borderBottom: null, borderLeft: null, borderRight: null },
          });
        if (operation.border === "outline") {
          const [top, bottom, left, right] = [rows[0]!, rows.at(-1)!, cols[0]!, cols.at(-1)!];
          formats.push(
            { area: { ...whole, r2: top }, patch: { borderTop: true } },
            { area: { ...whole, r1: bottom }, patch: { borderBottom: true } },
            { area: { ...whole, c2: left }, patch: { borderLeft: true } },
            { area: { ...whole, c1: right }, patch: { borderRight: true } },
          );
        }
        emit(...formats.map((each) => ({ op: "format" as const, sh, ...each })));
        return;
      }
      case "setColumnWidth":
      case "setRowHeight": {
        const sh = sheetId(operation.sheet);
        const axis = operation.kind === "setRowHeight" ? "rows" : "columns";
        const picked = axisIds(
          sh,
          axis,
          operation.kind === "setRowHeight" ? operation.rows : operation.columns,
        );
        if (axis === "rows") ensure(sh, picked.last, 0);
        else ensure(sh, 0, picked.last);
        emit({
          op: "resize",
          sh,
          axis,
          ids: picked.ids(),
          size: operation.kind === "setRowHeight" ? operation.height : operation.width,
        });
        return;
      }
      case "mergeCells":
      case "unmergeCells": {
        const sh = sheetId(operation.sheet);
        const { rows, cols, ids: box } = area(sh, operation.range);
        if (operation.kind === "mergeCells") {
          // The top-left cell stays; the rest of the range is what merging loses.
          const lost = new Set(rows.slice(1));
          guard(sh, lost, new Set(cols));
          guard(sh, new Set(rows.slice(0, 1)), new Set(cols.slice(1)));
        }
        emit({ op: operation.kind === "mergeCells" ? "merge" : "unmerge", sh, box });
        return;
      }
      case "freezePanes": {
        const sh = sheetId(operation.sheet);
        const cell = parseCell(operation.cell)!;
        ensure(sh, cell.row, cell.column);
        emit({
          op: "freeze",
          sh,
          row: cell.row > 1 ? ids(sh, "rows")[cell.row - 2]! : null,
          col: cell.column > 1 ? ids(sh, "columns")[cell.column - 2]! : null,
        });
        return;
      }
      case "insertRows":
      case "insertColumns": {
        const sh = sheetId(operation.sheet);
        const axis = operation.kind === "insertRows" ? "rows" : "columns";
        const picked = axisIds(
          sh,
          axis,
          operation.kind === "insertRows" ? operation.rows : operation.columns,
        );
        if (axis === "rows") ensure(sh, picked.first - 1, 0);
        else ensure(sh, 0, picked.first - 1);
        const entries = axis === "rows" ? view.sheet[sh]!.rows : view.sheet[sh]!.cols;
        const count = picked.last - picked.first + 1;
        const limit = axis === "rows" ? LIVE_LIMITS.rows : LIVE_LIMITS.cols;
        if (entries.length + count > limit)
          throw new Refused("invalid", `A live sheet holds at most ${limit} ${axis}.`);
        emit({
          op: "insert",
          sh,
          axis,
          ids: Array.from({ length: count }, input.mint),
          after: picked.first === 1 ? null : ids(sh, axis)[picked.first - 2]!,
        });
        return;
      }
      case "deleteRows":
      case "deleteColumns": {
        const sh = sheetId(operation.sheet);
        const axis = operation.kind === "deleteRows" ? "rows" : "columns";
        const doomed = axisIds(
          sh,
          axis,
          operation.kind === "deleteRows" ? operation.rows : operation.columns,
        ).ids();
        if (!doomed.length) return;
        if (doomed.length >= ids(sh, axis).length)
          throw new Refused("invalid", `A sheet keeps at least one of its ${axis}.`);
        guard(
          sh,
          axis === "rows" ? new Set(doomed) : null,
          axis === "rows" ? null : new Set(doomed),
        );
        emit({ op: "delete", sh, axis, ids: doomed });
        return;
      }
      case "fill":
      case "copy": {
        const sh = sheetId(operation.sheet);
        const source = parseRange(operation.kind === "fill" ? operation.source : operation.range)!;
        const target =
          operation.kind === "fill"
            ? parseRange(operation.range)!
            : (() => {
                const to = parseCell(operation.to)!;
                return {
                  top: to.row,
                  left: to.column,
                  bottom: to.row + source.bottom - source.top,
                  right: to.column + source.right - source.left,
                };
              })();
        const destination =
          operation.kind === "copy" && operation.toSheet ? sheetId(operation.toSheet) : sh;
        ensure(sh, source.bottom, source.right);
        ensure(destination, target.bottom, target.right);
        const height = source.bottom - source.top + 1;
        const width = source.right - source.left + 1;
        // Read every source cell before anything is written: the ranges may overlap.
        const sourceRows = ids(sh, "rows");
        const sourceCols = ids(sh, "columns");
        const reads: Array<{
          row: number;
          col: number;
          fromRow: number;
          fromCol: number;
          cell: Cell | undefined;
        }> = [];
        for (let row = target.top; row <= target.bottom; row++)
          for (let col = target.left; col <= target.right; col++) {
            const inside =
              destination === sh &&
              row >= source.top &&
              row <= source.bottom &&
              col >= source.left &&
              col <= source.right;
            if (operation.kind === "fill" && inside) continue;
            const fromRow = source.top + ((((row - target.top) % height) + height) % height);
            const fromCol = source.left + ((((col - target.left) % width) + width) % width);
            reads.push({
              row,
              col,
              fromRow,
              fromCol,
              cell: view.sheet[sh]!.cells[sourceRows[fromRow - 1]!]?.[sourceCols[fromCol - 1]!],
            });
          }
        const targetRows = ids(destination, "rows");
        const targetCols = ids(destination, "columns");
        guard(
          destination,
          new Set(targetRows.slice(target.top - 1, target.bottom)),
          new Set(targetCols.slice(target.left - 1, target.right)),
        );
        const cells: CellWrite[] = reads.map(({ fromRow, fromCol, ...read }) => {
          const r = ids(destination, "rows")[read.row - 1]!;
          const c = ids(destination, "columns")[read.col - 1]!;
          if (read.cell?.f)
            return {
              r,
              c,
              f: copied(read.cell.f, sh, destination, {
                rows: read.row - fromRow,
                cols: read.col - fromCol,
              }),
            };
          return { r, c, v: read.cell?.v ?? null };
        });
        if (cells.length) emit({ op: "set", sh: destination, cells });
        return;
      }
      case "sort": {
        const sh = sheetId(operation.sheet);
        const { box, rows, cols } = area(sh, operation.range);
        const by = parseCell(`${operation.by}1`)!.column;
        if (by < box.left || by > box.right)
          throw new Refused("invalid", `Sort by a column inside ${operation.range}.`);
        const sorted = operation.header ? rows.slice(1) : rows;
        if (sorted.length < 2) return;
        guard(sh, new Set(sorted), new Set(cols));
        const values = calculateSheet(view, input.context);
        const byId = ids(sh, "columns")[by - 1]!;
        const keyed = sorted.map((r, index) => {
          return { r, index, value: values.value(sh, r, byId) };
        });
        keyed.sort((a, b) => {
          // Blanks go last whichever way the rest is sorted.
          if (blank(a.value) !== blank(b.value)) return blank(a.value) ? 1 : -1;
          const order = compare(a.value, b.value) * (operation.descending ? -1 : 1);
          return order || a.index - b.index;
        });
        const order = keyed.map((each) => each.r);
        if (order.every((r, index) => r === sorted[index])) return;
        emit({ op: "sort", sh, c1: cols[0]!, c2: cols.at(-1)!, rows: sorted, order });
        return;
      }
      case "addSheet": {
        if (sheetNamed(view, operation.name))
          throw new Refused("invalid", `A sheet named ${operation.name} exists already.`);
        const id = input.mint();
        emit({
          op: "sheetAdd",
          id,
          name: operation.name,
          after: liveSheets(view).at(-1) ?? null,
          rows: Array.from({ length: NEW_SHEET.rows }, (_, index) => `${id}.r${index + 1}`),
          cols: Array.from({ length: NEW_SHEET.cols }, (_, index) => `${id}.c${index + 1}`),
        });
        return;
      }
      case "renameSheet": {
        const sh = sheetId(operation.sheet);
        const other = sheetNamed(view, operation.name);
        if (other && other !== sh)
          throw new Refused("invalid", `A sheet named ${operation.name} exists already.`);
        emit({ op: "sheetRename", id: sh, name: operation.name });
        return;
      }
      case "moveSheet": {
        const sh = sheetId(operation.sheet);
        const others = liveSheets(view).filter((each) => each !== sh);
        emit({
          op: "sheetMove",
          id: sh,
          after:
            operation.position === 1 ? null : (others[operation.position - 2] ?? others.at(-1)!),
        });
        return;
      }
      case "deleteSheet": {
        const sh = sheetId(operation.sheet);
        if (liveSheets(view).length === 1)
          throw new Refused("invalid", "A sheet document keeps at least one sheet.");
        guard(sh, null, null);
        emit({ op: "sheetDelete", id: sh });
        return;
      }
      case "defineName": {
        const sh = sheetId(operation.sheet);
        const box = parseRange(operation.range)!;
        const text = `${quoteSheet(view.sheet[sh]!.name)}!${corner(box.top, box.left)}${
          box.bottom === box.top && box.right === box.left
            ? ""
            : `:${corner(box.bottom, box.right)}`
        }`;
        emit({ op: "name", name: operation.name, f: formula(text, sh) });
        return;
      }
    }
  };

  try {
    for (const operation of operations) one(operation);
  } catch (error) {
    if (error instanceof Refused)
      return { ok: false, outcome: error.outcome, message: error.message };
    throw error;
  }
  return { ok: true, ops: out, doc: view };
}
