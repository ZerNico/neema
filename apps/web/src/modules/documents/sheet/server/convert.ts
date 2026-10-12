import { rangeWide } from "@chat/sheet/model/conditional";
import { draft } from "@chat/sheet/model/draft";
import { applyChange } from "@chat/sheet/model/apply";
import { columnIndex, columnLetters, parseCell, parseRange } from "@chat/sheet/a1";
import type { Scalar } from "@chat/sheet/engine/evaluate";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { quoteSheet, renderFormula } from "@chat/sheet/model/formula";
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
import { parseChange, type CellWrite, type SheetOp, type StylePatch } from "@chat/sheet/model/ops";
import type { BorderLine } from "@chat/sheet/model/style";
import type { CellInput } from "~/modules/spreadsheets/operations.ts";
import type { LiveSheetOperation } from "../live-operations.ts";
import type { FilterCondition, FilterRule } from "@chat/sheet/model/filter";
import type { ConditionalRule } from "@chat/sheet/model/conditional";
import type { ValidationRule } from "@chat/sheet/model/validation";
import { withoutBounds } from "@chat/sheet/model/box";
import { OUTLINE_LIMITS } from "@chat/sheet/model/outline";
import { parseDateText } from "@chat/sheet/dates";
import { chartOperation } from "./convert-chart.ts";

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
/** A link the model gives: none, or a web or mail address, never anything a click would run. */
function linkOf(text: string): string | null {
  if (text.trim() === "" || text.trim().toLowerCase() === "none") return null;
  try {
    const url = new URL(text.trim());
    if (url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:")
      return url.href;
  } catch {
    // Read below as refused.
  }
  throw new Refused("invalid", `link: "${text.slice(0, 80)}" is not a web or mail address.`);
}

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
  const plan = draft(input.doc, input.mint);
  const emit = plan.push;

  const sheetId = (name: string) => {
    const id = sheetNamed(plan.doc, name);
    if (id) return id;
    const names = liveSheets(plan.doc).map((each) => plan.doc.sheet[each]!.name);
    throw new Refused("not_found", `No sheet named ${name}. Sheets: ${names.join(", ")}.`);
  };
  const ids = (sh: string, axis: Axis) =>
    positions(axis === "rows" ? plan.doc.sheet[sh]!.rows : plan.doc.sheet[sh]!.cols).ids;
  /** Grows a sheet's grid to at least this many rows and columns. */
  const ensure = (sh: string, rows: number, cols: number) => {
    const over = plan.ensure(sh, rows, cols);
    if (over) throw new Refused("invalid", over);
  };
  const label = (sh: string, r: string, c: string) =>
    `${quoteSheet(plan.doc.sheet[sh]!.name)}!${columnLetters(positions(plan.doc.sheet[sh]!.cols).at(c) ?? 0)}${positions(plan.doc.sheet[sh]!.rows).at(r) ?? 0}`;
  const changedSince = (cell: Cell | undefined) =>
    !!cell && cell.w > input.seen && !input.own.has(cell.w);
  /** Refuses touching cells someone else changed since the model's plan.doc. */
  const conflictMessage = (sh: string, r: string, c: string) =>
    `${label(sh, r, c)} changed since your view of the sheet. Nothing was applied; the view now shows it, so check it and send the call again.`;
  const guard = (
    sh: string,
    rows: ReadonlySet<string> | null,
    cols: ReadonlySet<string> | null,
  ) => {
    for (const [r, row] of Object.entries(plan.doc.sheet[sh]!.cells)) {
      if (rows && !rows.has(r)) continue;
      for (const [c, cell] of Object.entries(row))
        if ((!cols || cols.has(c)) && changedSince(cell))
          throw new Refused("conflict", conflictMessage(sh, r, c));
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
    const parsed = plan.formula(text, sh);
    if (parsed) return parsed;
    throw new Refused("invalid", `=${text.slice(0, 80)} reaches past what a live sheet holds.`);
  };
  /** A formula copied by a distance, its references then read on the target sheet. */
  const copied = (f: Formula, from: string, to: string, shift: { rows: number; cols: number }) => {
    const result = plan.copy(f, shift, from);
    if (!result)
      throw new Refused("invalid", "A copied formula reaches past what a live sheet holds.");
    return from === to
      ? result
      : formula(renderFormula(result, { doc: plan.doc, sheet: from }), to);
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
        // Exactly the cells written: rows of different lengths leave the rest of their box alone.
        for (const { r, c } of targets) {
          const cell = plan.doc.sheet[sh]!.cells[r]?.[c];
          if (cell && changedSince(cell)) throw new Refused("conflict", conflictMessage(sh, r, c));
        }
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
          "underline",
          "strike",
          "fontSize",
          "fontColor",
          "horizontal",
          "vertical",
          "wrap",
        ] as const)
          if (operation[key] !== undefined) patch[key] = operation[key];
        if (operation.font !== undefined) patch.fontFamily = operation.font;
        if (operation.link !== undefined) patch.link = linkOf(operation.link);
        if (operation.fill !== undefined)
          patch.fill = operation.fill === "none" ? null : operation.fill;
        if (operation.numberFormat !== undefined)
          patch.numberFormat =
            operation.numberFormat.toLowerCase() === "general" ? null : operation.numberFormat;
        const formats: Array<{ area: typeof whole; patch: StylePatch }> = [];
        if (Object.keys(patch).length) formats.push({ area: whole, patch });
        const line: BorderLine = {
          style: operation.borderStyle ?? "thin",
          ...(operation.borderColor && operation.borderColor !== "none"
            ? { color: operation.borderColor }
            : {}),
        };
        const [top, bottom, left, right] = [rows[0]!, rows.at(-1)!, cols[0]!, cols.at(-1)!];
        const topEdge = { area: { ...whole, r2: top }, patch: { borderTop: line } };
        const bottomEdge = { area: { ...whole, r1: bottom }, patch: { borderBottom: line } };
        if (operation.border === "all")
          formats.push({
            area: whole,
            patch: { borderTop: line, borderBottom: line, borderLeft: line, borderRight: line },
          });
        if (operation.border === "none")
          formats.push({
            area: whole,
            patch: { borderTop: null, borderBottom: null, borderLeft: null, borderRight: null },
          });
        if (operation.border === "top") formats.push(topEdge);
        if (operation.border === "bottom") formats.push(bottomEdge);
        if (operation.border === "outline")
          formats.push(
            topEdge,
            bottomEdge,
            { area: { ...whole, c2: left }, patch: { borderLeft: line } },
            { area: { ...whole, c1: right }, patch: { borderRight: line } },
          );
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
        const entries = axis === "rows" ? plan.doc.sheet[sh]!.rows : plan.doc.sheet[sh]!.cols;
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
              cell: plan.doc.sheet[sh]!.cells[sourceRows[fromRow - 1]!]?.[sourceCols[fromCol - 1]!],
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
        const values = calculateSheet(plan.doc, input.context);
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
        const sort = {
          op: "sort",
          sh,
          c1: cols[0]!,
          c2: cols.at(-1)!,
          rows: sorted,
          order,
        } as const;
        const checked = applyChange(plan.doc, { clientId: "draft", seq: 0, ops: [sort] }, -1);
        if (checked.dropped.length) throw new Refused("invalid", checked.dropped[0]!);
        emit(sort);
        return;
      }
      case "addSheet": {
        if (sheetNamed(plan.doc, operation.name))
          throw new Refused("invalid", `A sheet named ${operation.name} exists already.`);
        const id = input.mint();
        emit({
          op: "sheetAdd",
          id,
          name: operation.name,
          after: liveSheets(plan.doc).at(-1) ?? null,
          rows: Array.from({ length: NEW_SHEET.rows }, (_, index) => `${id}.r${index + 1}`),
          cols: Array.from({ length: NEW_SHEET.cols }, (_, index) => `${id}.c${index + 1}`),
        });
        return;
      }
      case "renameSheet": {
        const sh = sheetId(operation.sheet);
        const other = sheetNamed(plan.doc, operation.name);
        if (other && other !== sh)
          throw new Refused("invalid", `A sheet named ${operation.name} exists already.`);
        emit({ op: "sheetRename", id: sh, name: operation.name });
        return;
      }
      case "group": {
        const sh = sheetId(operation.sheet);
        if ((operation.rows === undefined) === (operation.columns === undefined))
          throw new Refused("invalid", "Give rows or columns to group, not both.");
        const axis = operation.rows !== undefined ? "rows" : "columns";
        const picked = axisIds(sh, axis, (operation.rows ?? operation.columns)!);
        if (axis === "rows") ensure(sh, picked.last, 0);
        else ensure(sh, 0, picked.last);
        const chosen = picked.ids();
        const [from, to] = [chosen[0]!, chosen.at(-1)!];
        const key = axis === "rows" ? "rows" : "cols";
        const list = plan.doc.sheet[sh]!.outline?.[key] ?? [];
        const at = list.findIndex((each) => each.from === from && each.to === to);
        const shaped = (collapsed: boolean | undefined) => ({
          from,
          to,
          ...(collapsed ? { collapsed: true as const } : {}),
        });
        if (operation.remove) {
          if (at === -1) throw new Refused("not_found", "No group on that span to remove.");
          emit({ op: "outline", sh, axis, list: list.filter((_, index) => index !== at) });
          return;
        }
        if (at === -1 && list.length >= OUTLINE_LIMITS.groups)
          throw new Refused("invalid", `At most ${OUTLINE_LIMITS.groups} groups on an axis.`);
        emit({
          op: "outline",
          sh,
          axis,
          list:
            at === -1
              ? [...list, shaped(operation.collapsed)]
              : list.map((each, index) =>
                  index === at ? shaped(operation.collapsed ?? each.collapsed) : each,
                ),
        });
        return;
      }
      case "colorSheet": {
        emit({ op: "sheetColor", id: sheetId(operation.sheet), color: operation.color ?? null });
        return;
      }
      case "moveSheet": {
        const sh = sheetId(operation.sheet);
        const others = liveSheets(plan.doc).filter((each) => each !== sh);
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
        if (liveSheets(plan.doc).length === 1)
          throw new Refused("invalid", "A sheet document keeps at least one sheet.");
        guard(sh, null, null);
        emit({ op: "sheetDelete", id: sh });
        return;
      }
      case "addChart":
      case "editChart": {
        emit(
          chartOperation(operation, {
            view: () => plan.doc,
            sheetId,
            ids,
            ensure,
            mint: input.mint,
            context: input.context,
            refuse: (message, outcome = "invalid") => {
              throw new Refused(outcome, message);
            },
          }),
        );
        return;
      }
      case "setFilter": {
        const sh = sheetId(operation.sheet);
        const existing = plan.doc.sheet[sh]!.filter;
        let box = existing?.box;
        if (operation.range) {
          const { ids: whole } = area(sh, operation.range);
          if (whole.r1 === whole.r2)
            throw new Refused("invalid", "A filter's range needs a header row and rows below it.");
          box = { r1: whole.r1!, r2: whole.r2!, c1: whole.c1!, c2: whole.c2! };
        }
        if (!box) throw new Refused("invalid", "This sheet has no filter yet; give its range.");
        // A new range keeps the rules of columns still inside it.
        const kept = existing && operation.range ? existing.rules : (existing?.rules ?? {});
        const rules: Record<string, FilterRule> = { ...kept };
        if (operation.column) {
          const letters = operation.column.split(":")[0]!;
          const column = ids(sh, "columns")[columnIndex(letters.toUpperCase()) - 1];
          const inside = positions(plan.doc.sheet[sh]!.cols);
          const at = column ? inside.at(column) : undefined;
          if (!column || at === undefined || at < inside.at(box.c1)! || at > inside.at(box.c2)!)
            throw new Refused("invalid", `Column ${letters} is outside the filter's range.`);
          if (operation.clear) delete rules[column];
          else if (operation.keep || operation.condition) {
            const number = Number(operation.value);
            rules[column] = {
              ...(operation.keep ? { values: operation.keep } : {}),
              ...(operation.condition
                ? {
                    condition: {
                      op: operation.condition as FilterCondition,
                      ...(operation.value === undefined
                        ? {}
                        : {
                            value:
                              operation.value.trim() !== "" && Number.isFinite(number)
                                ? number
                                : operation.value,
                          }),
                    },
                  }
                : {}),
            };
          }
        }
        emit({ op: "filter", sh, filter: { box, rules } });
        return;
      }
      case "addConditionalFormat": {
        const sh = sheetId(operation.sheet);
        const { ids: box } = area(sh, operation.range);
        const style = {
          ...(operation.fill ? { fill: operation.fill } : {}),
          ...(operation.fontColor ? { fontColor: operation.fontColor } : {}),
          ...(operation.bold ? { bold: true } : {}),
        };
        const looks = Object.keys(style).length ? style : { fill: "#FFC7CE", fontColor: "#9C0006" };
        const operand = (text: string | undefined, field: string) => {
          if (text === undefined || !text.trim())
            throw new Refused("invalid", `${operation.type} needs ${field}.`);
          const number = Number(text);
          return Number.isFinite(number) ? number : text;
        };
        const kind = operation.type;
        const rule: ConditionalRule =
          kind === "greater" || kind === "less" || kind === "equal" || kind === "notEqual"
            ? {
                kind: "compare",
                op: kind,
                values: [operand(operation.value, "value")],
                style: looks,
              }
            : kind === "between"
              ? {
                  kind: "compare",
                  op: "between",
                  values: [operand(operation.value, "value"), operand(operation.value2, "value2")],
                  style: looks,
                }
              : kind === "textContains"
                ? {
                    kind: "text",
                    op: "contains",
                    text: String(operand(operation.value, "value")),
                    style: looks,
                  }
                : kind === "top" || kind === "bottom"
                  ? {
                      kind: "top",
                      count: operation.count ?? 10,
                      ...(operation.percent ? { percent: true } : {}),
                      ...(kind === "bottom" ? { bottom: true } : {}),
                      style: looks,
                    }
                  : kind === "aboveAverage" || kind === "belowAverage"
                    ? {
                        kind: "average",
                        ...(kind === "belowAverage" ? { below: true } : {}),
                        style: looks,
                      }
                    : kind === "duplicate" || kind === "unique"
                      ? {
                          kind: "duplicate",
                          ...(kind === "unique" ? { unique: true } : {}),
                          style: looks,
                        }
                      : kind === "blank"
                        ? { kind: "blank", style: looks }
                        : kind === "colorScale"
                          ? {
                              kind: "scale",
                              colors: (operation.colors?.length === 2 ||
                              operation.colors?.length === 3
                                ? operation.colors
                                : ["#F8696B", "#FFEB84", "#63BE7B"]) as
                                | [string, string]
                                | [string, string, string],
                            }
                          : { kind: "bar", color: operation.color ?? "#638EC6" };
        const list = plan.doc.sheet[sh]!.conditional ?? [];
        emit({
          op: "conditional",
          sh,
          list: [
            ...list,
            { id: input.mint(), box: { r1: box.r1!, r2: box.r2!, c1: box.c1!, c2: box.c2! }, rule },
          ],
        });
        return;
      }
      case "clearConditionalFormats": {
        const sh = sheetId(operation.sheet);
        const list = plan.doc.sheet[sh]!.conditional ?? [];
        if (!operation.range) {
          emit({ op: "conditional", sh, list: [] });
          return;
        }
        // From exactly these cells, as Excel trims a rule partly over them.
        const { box } = area(sh, operation.range);
        emit({
          op: "conditional",
          sh,
          list: withoutBounds(plan.doc.sheet[sh]!, list, box, input.mint, rangeWide),
        });
        return;
      }
      case "setValidation": {
        const sh = sheetId(operation.sheet);
        const { box, ids: target } = area(sh, operation.range);
        let rule: ValidationRule;
        if (operation.type === "list") {
          if (operation.source) {
            const text = operation.source;
            const bang = text.lastIndexOf("!");
            const on =
              bang === -1
                ? sh
                : sheetId(
                    text
                      .slice(0, bang)
                      .replace(/^'(.*)'$/, "$1")
                      .replaceAll("''", "'"),
                  );
            const cells = (bang === -1 ? text : text.slice(bang + 1)).replaceAll("$", "");
            if (!parseRange(cells))
              throw new Refused("invalid", `source: "${text}" is not a range like Lists!A2:A20.`);
            rule = { kind: "list", source: { sh: on, box: area(on, cells).ids } };
          } else if (operation.choices?.length)
            rule = { kind: "list", values: [...new Set(operation.choices)] };
          else throw new Refused("invalid", "A list needs choices or a source.");
        } else {
          const test = operation.test ?? "between";
          const number = (text: string | undefined, field: string) => {
            const read =
              text === undefined || !text.trim()
                ? null
                : Number.isFinite(Number(text))
                  ? Number(text)
                  : operation.type === "date"
                    ? parseDateText(text)
                    : null;
            if (read === null)
              throw new Refused(
                "invalid",
                `${operation.type} needs ${field} as a number${operation.type === "date" ? ' or a date like "2026-01-31"' : ""}.`,
              );
            return read;
          };
          const low = number(operation.value, "value");
          rule = {
            kind: operation.type,
            test,
            values:
              test === "between" || test === "notBetween"
                ? [low, number(operation.value2, "value2")]
                : [low],
          };
        }
        // Other rules give up these cells, as Excel keeps one rule per cell.
        const kept = withoutBounds(
          plan.doc.sheet[sh]!,
          plan.doc.sheet[sh]!.validations ?? [],
          box,
          input.mint,
        );
        emit({
          op: "validations",
          sh,
          list: [
            ...kept,
            {
              id: input.mint(),
              box: { r1: target.r1!, r2: target.r2!, c1: target.c1!, c2: target.c2! },
              rule,
              onError: operation.onError ?? "stop",
              allowBlank: operation.allowBlank ?? true,
              ...(operation.message ? { message: operation.message } : {}),
            },
          ],
        });
        return;
      }
      case "clearValidation": {
        const sh = sheetId(operation.sheet);
        if (!operation.range) {
          emit({ op: "validations", sh, list: [] });
          return;
        }
        const { box } = area(sh, operation.range);
        const sheet = plan.doc.sheet[sh]!;
        emit({
          op: "validations",
          sh,
          list: withoutBounds(sheet, sheet.validations ?? [], box, input.mint),
        });
        return;
      }
      case "removeFilter": {
        emit({ op: "filter", sh: sheetId(operation.sheet), filter: null });
        return;
      }
      case "removeChart": {
        if (!plan.doc.charts[operation.chart])
          throw new Refused(
            "not_found",
            `No chart ${operation.chart}; the view lists them in <charts>.`,
          );
        emit({ op: "chartDelete", id: operation.chart });
        return;
      }
      case "defineName": {
        const sh = sheetId(operation.sheet);
        const box = parseRange(operation.range)!;
        const text = `${quoteSheet(plan.doc.sheet[sh]!.name)}!${corner(box.top, box.left)}${
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
  // Held to what a person's change is held to, such as how many rules a sheet keeps.
  const checked = parseChange({ clientId: "model", seq: 1, ops: plan.ops });
  if (!checked.ok)
    return { ok: false, outcome: "invalid", message: `Nothing was applied: ${checked.error}.` };
  return { ok: true, ops: plan.ops, doc: plan.doc };
}
