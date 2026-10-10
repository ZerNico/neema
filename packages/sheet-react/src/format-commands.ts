import { columnLetters } from "@chat/sheet/a1";
import { generalText } from "@chat/sheet/number-format";
import { positions, type Box } from "@chat/sheet/model";
import type { SheetOp, StylePatch } from "@chat/sheet/model/ops";
import { enterCell, selectionBox, type GridContext } from "./commands.ts";
import { cellStyle } from "./display.ts";

/**
 * The Home tab's formatting commands, as operations on the selection:
 * borders, decimals, AutoSum, merging, freezing and clearing. Pure, like
 * every command, so the toolbar only calls them.
 */

export type BorderKind = "all" | "outer" | "inner" | "top" | "bottom" | "left" | "right" | "none";

/** Borders on the selection as Excel's border menu sets them, thin lines on cell edges. */
export function borderSelection(context: GridContext, kind: BorderKind): SheetOp[] {
  const box = selectionBox(context);
  const area = box.area;
  const [first, last] = [box.rowIds[0]!, box.rowIds.at(-1)!];
  const [left, right] = [box.colIds[0]!, box.colIds.at(-1)!];
  const format = (part: Box, patch: StylePatch): SheetOp => ({
    op: "format",
    sh: context.sheet,
    area: part,
    patch,
  });
  const none = { borderTop: null, borderBottom: null, borderLeft: null, borderRight: null };
  const outer = [
    format({ ...area, r2: first }, { borderTop: true }),
    format({ ...area, r1: last }, { borderBottom: true }),
    format({ ...area, c2: left }, { borderLeft: true }),
    format({ ...area, c1: right }, { borderRight: true }),
  ];
  // Inside lines: each cell's right edge but the last column's, each bottom edge but the last row's.
  const inner = [
    ...(box.colIds.length > 1
      ? [format({ ...area, c2: box.colIds.at(-2)! }, { borderRight: true })]
      : []),
    ...(box.rowIds.length > 1
      ? [format({ ...area, r2: box.rowIds.at(-2)! }, { borderBottom: true })]
      : []),
  ];
  switch (kind) {
    case "none":
      return [format(area, none)];
    case "all":
      return [
        format(area, { borderTop: true, borderBottom: true, borderLeft: true, borderRight: true }),
      ];
    case "outer":
      return outer;
    case "inner":
      return inner;
    case "top":
      return [outer[0]!];
    case "bottom":
      return [outer[1]!];
    case "left":
      return [outer[2]!];
    case "right":
      return [outer[3]!];
  }
}

/** A number format with one decimal more or fewer in each of its number sections. */
export function shiftDecimals(code: string, delta: 1 | -1): string {
  return code
    .split(";")
    .map((section) => {
      // Text in quotes and brackets is literal; only the digits after the last 0 or # move.
      const match = /^(.*?[0#?])(\.([0#?]*))?([^0#?]*)$/.exec(section);
      if (!match) return section;
      const [, whole = "", , decimals = "", tail = ""] = match;
      const count = Math.max(0, decimals.length + delta);
      return `${whole}${count ? `.${"0".repeat(count)}` : ""}${tail}`;
    })
    .join(";");
}

/** Increase or Decrease Decimal: the active cell's format with one decimal more or fewer, on the selection. */
export function decimalsSelection(context: GridContext, delta: 1 | -1): SheetOp[] {
  const { head } = context.selection;
  const style = cellStyle(context.doc.sheet[context.sheet]!.cells[head.r]?.[head.c]?.s);
  let code = style.numberFormat;
  if (!code || code === "General") {
    // As shown in General: as many decimals as the value shows now.
    const value = context.values.value(context.sheet, head.r, head.c);
    const shown = typeof value === "number" ? generalText(value, context.locale) : "0";
    const decimals = /[.,](\d+)$/.exec(shown)?.[1]?.length ?? 0;
    code = decimals ? `0.${"0".repeat(decimals)}` : "0";
  }
  const next = shiftDecimals(code, delta);
  return next === code
    ? []
    : [
        {
          op: "format",
          sh: context.sheet,
          area: selectionBox(context).area,
          patch: { numberFormat: next },
        },
      ];
}

const at = (row: number, col: number) => `${columnLetters(col)}${row}`;

export type AutoSumKind = "SUM" | "AVERAGE" | "COUNT" | "MAX" | "MIN";

/**
 * AutoSum as Excel's button does it. In one cell, the run of numbers above
 * it (or else to its left) is totalled there. Over a range, each column gets
 * its total in the row below.
 */
export function autoSum(context: GridContext, kind: AutoSumKind = "SUM"): SheetOp[] {
  const box = selectionBox(context);
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows).ids;
  const cols = positions(sheet.cols).ids;
  const isNumber = (row: number, col: number) =>
    !!rows[row - 1] &&
    !!cols[col - 1] &&
    typeof context.values.value(context.sheet, rows[row - 1]!, cols[col - 1]!) === "number";
  if (box.top === box.bottom && box.left === box.right) {
    let top = box.top;
    while (top > 1 && isNumber(top - 1, box.left)) top--;
    let left = box.left;
    while (left > 1 && isNumber(box.top, left - 1)) left--;
    const range =
      top < box.top
        ? `${at(top, box.left)}:${at(box.top - 1, box.left)}`
        : left < box.left
          ? `${at(box.top, left)}:${at(box.top, box.left - 1)}`
          : null;
    return range ? enterCell(context, context.selection.head, `=${kind}(${range})`) : [];
  }
  // Below each column of the range, its total.
  const below = box.bottom + 1;
  if (!rows[below - 1]) return [];
  return Array.from({ length: box.right - box.left + 1 }, (_, x) => box.left + x).flatMap((col) =>
    enterCell(
      context,
      { r: rows[below - 1]!, c: cols[col - 1]! },
      `=${kind}(${at(box.top, col)}:${at(box.bottom, col)})`,
    ),
  );
}

export type MergeKind = "center" | "across" | "cells" | "unmerge";

/** Merge & Center, Merge Across (each row on its own), Merge Cells, or Unmerge. */
export function mergeSelection(context: GridContext, kind: MergeKind): SheetOp[] {
  const box = selectionBox(context);
  if (kind === "unmerge") return [{ op: "unmerge", sh: context.sheet, box: box.area }];
  if (box.top === box.bottom && box.left === box.right) return [];
  if (kind === "across")
    return box.colIds.length < 2
      ? []
      : box.rowIds.map((r) => ({
          op: "merge" as const,
          sh: context.sheet,
          box: { ...box.area, r1: r, r2: r },
        }));
  return [
    { op: "merge", sh: context.sheet, box: box.area },
    ...(kind === "center"
      ? [
          {
            op: "format" as const,
            sh: context.sheet,
            area: box.area,
            patch: { horizontal: "center" },
          },
        ]
      : []),
  ];
}

export type FreezeKind = "top" | "first" | "selection" | "none";

/** Freeze Panes: the top row, the first column, everything above and left of the active cell, or nothing. */
export function freezeAt(context: GridContext, kind: FreezeKind): SheetOp[] {
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const { head } = context.selection;
  const [row, col] = [rows.at(head.r) ?? 1, cols.at(head.c) ?? 1];
  const frozen =
    kind === "top"
      ? { row: rows.ids[0] ?? null, col: null }
      : kind === "first"
        ? { row: null, col: cols.ids[0] ?? null }
        : kind === "selection"
          ? {
              row: row > 1 ? rows.ids[row - 2]! : null,
              col: col > 1 ? cols.ids[col - 2]! : null,
            }
          : { row: null, col: null };
  return [{ op: "freeze", sh: context.sheet, ...frozen }];
}

/** Clear Formats or Clear All, as the eraser menu offers beside Delete's contents. */
export function clearSelectionAs(context: GridContext, what: "formats" | "all"): SheetOp[] {
  return [{ op: "clear", sh: context.sheet, area: selectionBox(context).area, what }];
}
