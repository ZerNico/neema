import { columnLetters } from "@chat/sheet/a1";
import { generalText } from "@chat/sheet/number-format";
import { positions, type Box } from "@chat/sheet/model";
import type { ConditionalRule } from "@chat/sheet/model/conditional";
import { withoutArea, type Validation } from "@chat/sheet/model/validation";
import type { SheetOp, StylePatch } from "@chat/sheet/model/ops";
import { enterCell, rangesOf, selectionBox, type GridContext } from "./commands.ts";
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

/**
 * What Excel's status bar says of a selection of more than one cell: how
 * many hold anything, and the sum and average of its numbers. Null for one
 * cell, as there it says nothing.
 */
export function selectionStats(context: GridContext, limit = 200_000) {
  // Every selected range, each cell counted once where ranges overlap, as Excel's status bar.
  const boxes = rangesOf(context).map((selection) => selectionBox({ ...context, selection }));
  if (boxes.length === 1 && boxes[0]!.rowIds.length * boxes[0]!.colIds.length < 2) return null;
  let [count, numbers, sum] = [0, 0, 0];
  let seen = 0;
  const counted = new Set<string>();
  for (const box of boxes)
    for (const r of box.rowIds)
      for (const c of box.colIds) {
        // A whole sheet selected is counted only as far as is quick.
        if (++seen > limit) return { count, numbers, sum, average: numbers ? sum / numbers : null };
        if (boxes.length > 1) {
          if (counted.has(`${r}|${c}`)) continue;
          counted.add(`${r}|${c}`);
        }
        const value = context.values.value(context.sheet, r, c);
        if (value === null || value === "") continue;
        count++;
        if (typeof value === "number") {
          numbers++;
          sum += value;
        }
      }
  return { count, numbers, sum, average: numbers ? sum / numbers : null };
}

/** A conditional format on the selection, after the sheet's others, as Excel adds a new rule. */
export function addConditional(context: GridContext, rule: ConditionalRule): SheetOp[] {
  const list = context.doc.sheet[context.sheet]!.conditional ?? [];
  return [
    {
      op: "conditional",
      sh: context.sheet,
      list: [...list, { id: context.mint(), box: selectionBox(context).area, rule }],
    },
  ];
}

/** Clear Rules: those over the selected cells, or every one on the sheet. */
export function clearConditional(context: GridContext, scope: "selection" | "sheet"): SheetOp[] {
  const list = context.doc.sheet[context.sheet]!.conditional ?? [];
  if (!list.length) return [];
  if (scope === "sheet") return [{ op: "conditional", sh: context.sheet, list: [] }];
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const box = selectionBox(context);
  const overlaps = (area: Box) => {
    const [top, bottom, left, right] = [
      rows.at(area.r1) ?? 0,
      rows.at(area.r2) ?? 0,
      cols.at(area.c1) ?? 0,
      cols.at(area.c2) ?? 0,
    ];
    return top <= box.bottom && bottom >= box.top && left <= box.right && right >= box.left;
  };
  const kept = list.filter((each) => !overlaps(each.box));
  return kept.length === list.length ? [] : [{ op: "conditional", sh: context.sheet, list: kept }];
}

/** The sheet's rules after one is removed or moved up or down in priority, as Manage Rules does. */
export function editConditional(
  context: GridContext,
  id: string,
  action: "remove" | "up" | "down",
): SheetOp[] {
  const list = [...(context.doc.sheet[context.sheet]!.conditional ?? [])];
  const place = list.findIndex((each) => each.id === id);
  if (place === -1) return [];
  if (action === "remove") list.splice(place, 1);
  else {
    const to = action === "up" ? place - 1 : place + 1;
    if (to < 0 || to >= list.length) return [];
    [list[place], list[to]] = [list[to]!, list[place]!];
  }
  return [{ op: "conditional", sh: context.sheet, list }];
}

/**
 * Data Validation set on the selection, or cleared from it with null. Other
 * rules give up the selected cells and keep the rest, as Excel keeps one rule
 * per cell.
 */
export function setValidation(
  context: GridContext,
  validation: Omit<Validation, "id" | "box"> | null,
): SheetOp[] {
  const before = context.doc.sheet[context.sheet]!.validations ?? [];
  const box = selectionBox(context);
  const kept = withoutArea(context.doc, context.sheet, box, context.mint);
  if (!validation && JSON.stringify(kept) === JSON.stringify(before)) return [];
  const list = validation ? [...kept, { ...validation, id: context.mint(), box: box.area }] : kept;
  return [{ op: "validations", sh: context.sheet, list }];
}
