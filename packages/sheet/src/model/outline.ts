import { positions, type AxisEntry, type SheetDoc } from "./model.ts";
import { isId } from "./check.ts";

/**
 * Grouped rows or columns, as Excel's outline: a span by IDs that can be
 * collapsed. Groups nest by containing one another, which gives each its
 * level. Collapsed ones hide their rows or columns when drawn, never stored
 * as hidden, as a filter's rows are.
 */
export interface OutlineGroup {
  readonly from: string;
  readonly to: string;
  readonly collapsed?: true;
}
export interface SheetOutline {
  readonly rows?: readonly OutlineGroup[];
  readonly cols?: readonly OutlineGroup[];
}

/** Excel's deepest outline. */
export const OUTLINE_LEVELS = 7;
export const OUTLINE_LIMITS = { groups: 500 } as const;

/** Whether a list of groups, as an operation carries one, is well formed. */
export function isOutlineList(value: unknown): value is readonly OutlineGroup[] {
  return (
    Array.isArray(value) &&
    value.length <= OUTLINE_LIMITS.groups &&
    value.every(
      (each) =>
        typeof each === "object" &&
        each !== null &&
        isId(each.from) &&
        isId(each.to) &&
        (each.collapsed === undefined || each.collapsed === true) &&
        Object.keys(each).every((key) => key === "from" || key === "to" || key === "collapsed"),
    )
  );
}

/** A group as positions (from 1) on its axis, its level from the groups around it; null once gone. */
export interface PlacedGroup {
  readonly group: OutlineGroup;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  /** 1 for an outermost group. */
  readonly level: number;
}

/** An axis's groups by position, outermost first, each with its level. */
export function placeGroups(
  entries: readonly AxisEntry[],
  groups: readonly OutlineGroup[] | undefined,
): PlacedGroup[] {
  if (!groups?.length) return [];
  const index = positions(entries);
  const placed = groups.flatMap((group, at) => {
    const [a, b] = [index.at(group.from), index.at(group.to)];
    return a === undefined || b === undefined
      ? []
      : [{ group, index: at, start: Math.min(a, b), end: Math.max(a, b) }];
  });
  return placed
    .map((each) => ({
      ...each,
      level:
        1 +
        placed.filter(
          (other) =>
            other !== each &&
            other.start <= each.start &&
            other.end >= each.end &&
            // Of two equal spans, the earlier listed holds the later.
            (other.start !== each.start || other.end !== each.end || other.index < each.index),
        ).length,
    }))
    .toSorted((a, b) => a.level - b.level || a.start - b.start);
}

/** The deepest level on an axis, 0 without groups. */
export const outlineDepth = (placed: readonly PlacedGroup[]) =>
  Math.min(OUTLINE_LEVELS, Math.max(0, ...placed.map((each) => each.level)));

/** The IDs collapsed groups hide on one axis of a sheet. */
export function collapsedIds(doc: SheetDoc, sheet: string, axis: "rows" | "columns"): Set<string> {
  const data = doc.sheet[sheet];
  const hidden = new Set<string>();
  if (!data) return hidden;
  const entries = axis === "rows" ? data.rows : data.cols;
  const groups = axis === "rows" ? data.outline?.rows : data.outline?.cols;
  if (!groups?.some((each) => each.collapsed)) return hidden;
  const { ids } = positions(entries);
  for (const each of placeGroups(entries, groups))
    if (each.group.collapsed)
      for (let at = each.start; at <= each.end; at++) hidden.add(ids[at - 1]!);
  return hidden;
}
