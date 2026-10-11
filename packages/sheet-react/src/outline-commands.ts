import type { Axis, SheetDoc } from "@chat/sheet/model";
import {
  OUTLINE_LEVELS,
  placeGroups,
  type OutlineGroup,
  type PlacedGroup,
} from "@chat/sheet/model/outline";
import type { SheetOp } from "@chat/sheet/model/ops";
import { selectionBox, type GridContext } from "./commands.ts";

const keyOf = (axis: Axis) => (axis === "rows" ? "rows" : "cols");
const groupsOf = (doc: SheetDoc, sheet: string, axis: Axis) =>
  doc.sheet[sheet]!.outline?.[keyOf(axis)] ?? [];
const placedOf = (doc: SheetDoc, sheet: string, axis: Axis) => {
  const data = doc.sheet[sheet]!;
  return placeGroups(axis === "rows" ? data.rows : data.cols, groupsOf(doc, sheet, axis));
};
const write = (sheet: string, axis: Axis, list: readonly OutlineGroup[]): SheetOp[] => [
  { op: "outline", sh: sheet, axis, list },
];

/** Which axis Group and Ungroup act on: columns when whole columns are selected, else rows. */
export function outlineAxis(context: GridContext): Axis {
  const box = selectionBox(context);
  const rows = context.doc.sheet[context.sheet]!.rows.filter((entry) => !entry.dead).length;
  return box.top === 1 && box.bottom === rows ? "columns" : "rows";
}

/** Groups the selection's rows or columns, one level inside any group around them, as Excel's Group. */
export function groupSelection(context: GridContext, axis: Axis): SheetOp[] {
  const box = selectionBox(context);
  const ids = axis === "rows" ? box.rowIds : box.colIds;
  const [start, end] = axis === "rows" ? [box.top, box.bottom] : [box.left, box.right];
  const placed = placedOf(context.doc, context.sheet, axis);
  if (placed.some((each) => each.start === start && each.end === end)) return [];
  const around = placed.filter((each) => each.start <= start && each.end >= end).length;
  if (around >= OUTLINE_LEVELS) return [];
  return write(context.sheet, axis, [
    ...groupsOf(context.doc, context.sheet, axis),
    { from: ids[0]!, to: ids.at(-1)! },
  ]);
}

/** Takes away the innermost group touching the selection's rows or columns, as Excel's Ungroup. */
export function ungroupSelection(context: GridContext, axis: Axis): SheetOp[] {
  const box = selectionBox(context);
  const [start, end] = axis === "rows" ? [box.top, box.bottom] : [box.left, box.right];
  const touching = placedOf(context.doc, context.sheet, axis).filter(
    (each) => each.start <= end && each.end >= start,
  );
  const innermost = touching.toSorted((a, b) => b.level - a.level)[0];
  if (!innermost) return [];
  return write(
    context.sheet,
    axis,
    groupsOf(context.doc, context.sheet, axis).filter((_, index) => index !== innermost.index),
  );
}

/** Collapses or expands one group, by its place in the sheet's list. */
export function toggleGroup(doc: SheetDoc, sheet: string, axis: Axis, group: PlacedGroup) {
  return write(
    sheet,
    axis,
    groupsOf(doc, sheet, axis).map((each, index) =>
      index !== group.index
        ? each
        : each.collapsed
          ? { from: each.from, to: each.to }
          : { ...each, collapsed: true as const },
    ),
  );
}

/** Shows an axis down to a level, as Excel's numbered outline buttons: deeper groups collapse. */
export function showLevel(doc: SheetDoc, sheet: string, axis: Axis, level: number): SheetOp[] {
  const levels = new Map(placedOf(doc, sheet, axis).map((each) => [each.index, each.level]));
  const list = groupsOf(doc, sheet, axis).map((each, index) =>
    (levels.get(index) ?? 0) >= level
      ? { ...each, collapsed: true as const }
      : { from: each.from, to: each.to },
  );
  return JSON.stringify(list) === JSON.stringify(groupsOf(doc, sheet, axis))
    ? []
    : write(sheet, axis, list);
}
