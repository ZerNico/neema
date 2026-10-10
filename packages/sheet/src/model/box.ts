import { boxRef } from "../a1.ts";
import { positions, type Box, type Sheet } from "./model.ts";

/** A range by position: 1-based, inclusive, its corners in order. */
export interface Bounds {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/**
 * Where a range by IDs sits now, its corners in order whichever way they were
 * given; null once a corner's row or column is deleted. Every reader of a
 * rule, a chart's series or a filter goes through this, so all agree on what
 * a range with a dead end covers: nothing.
 */
export function boundsOf(sheet: Sheet | undefined, box: Box): Bounds | null {
  if (!sheet) return null;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const [r1, r2, c1, c2] = [rows.at(box.r1), rows.at(box.r2), cols.at(box.c1), cols.at(box.c2)];
  if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) return null;
  return {
    top: Math.min(r1, r2),
    bottom: Math.max(r1, r2),
    left: Math.min(c1, c2),
    right: Math.max(c1, c2),
  };
}

/** A range by IDs as A1 text, "B2:D9" or "B2" for one cell; null as for `boundsOf`. */
export function rangeA1(sheet: Sheet | undefined, box: Box): string | null {
  const bounds = boundsOf(sheet, box);
  return bounds ? boxRef(bounds) : null;
}

/** A range's live row and column IDs in order, with its bounds; null as for `boundsOf`. */
export function placeBox(sheet: Sheet | undefined, box: Box) {
  const bounds = boundsOf(sheet, box);
  if (!sheet || !bounds) return null;
  return {
    ...bounds,
    rows: positions(sheet.rows).ids.slice(bounds.top - 1, bounds.bottom),
    cols: positions(sheet.cols).ids.slice(bounds.left - 1, bounds.right),
  };
}

/** The range by IDs at some bounds of a sheet; the bounds must lie on it. */
export function boxAt(sheet: Sheet, bounds: Bounds): Box {
  const [rows, cols] = [positions(sheet.rows).ids, positions(sheet.cols).ids];
  return {
    r1: rows[bounds.top - 1]!,
    r2: rows[bounds.bottom - 1]!,
    c1: cols[bounds.left - 1]!,
    c2: cols[bounds.right - 1]!,
  };
}

export const overlaps = (a: Bounds, b: Bounds) =>
  a.top <= b.bottom && a.bottom >= b.top && a.left <= b.right && a.right >= b.left;

export const contains = (outer: Bounds, inner: Bounds) =>
  inner.top >= outer.top &&
  inner.bottom <= outer.bottom &&
  inner.left >= outer.left &&
  inner.right <= outer.right;

export const holds = (bounds: Bounds, row: number, col: number) =>
  row >= bounds.top && row <= bounds.bottom && col >= bounds.left && col <= bounds.right;

/**
 * Ranged items (rules) with an area taken out, as Excel clears rules from
 * exactly the cells chosen: one partly over the area keeps the rest of its
 * cells, as up to four items in its place, the first keeping its ID.
 */
export function withoutBounds<T extends { readonly id: string; readonly box: Box }>(
  sheet: Sheet,
  items: readonly T[],
  area: Bounds,
  mint: () => string,
): T[] {
  return items.flatMap((item) => {
    const bounds = boundsOf(sheet, item.box);
    if (!bounds || !overlaps(bounds, area)) return [item];
    const { top, bottom, left, right } = bounds;
    const [middleTop, middleBottom] = [Math.max(top, area.top), Math.min(bottom, area.bottom)];
    const pieces = [
      top < area.top && { top, bottom: area.top - 1, left, right },
      bottom > area.bottom && { top: area.bottom + 1, bottom, left, right },
      left < area.left && { top: middleTop, bottom: middleBottom, left, right: area.left - 1 },
      right > area.right && { top: middleTop, bottom: middleBottom, left: area.right + 1, right },
    ].filter((piece) => piece !== false);
    return pieces.map((piece, index) => ({
      ...item,
      id: index ? mint() : item.id,
      box: boxAt(sheet, piece),
    }));
  });
}
