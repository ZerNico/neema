import { positions, type Box } from "@chat/sheet/model";
import { filterSpan, filteredRows, shownText, type FilterRule } from "@chat/sheet/model/filter";
import type { SheetOp } from "@chat/sheet/model/ops";
import { selectionBox, sortRows, type GridContext, type SortKey } from "./commands.ts";

/**
 * The block of filled cells around the active cell, as Excel takes it for a
 * filter or Ctrl+A: grown while any neighbouring cell holds something.
 */
export function currentRegion(context: GridContext): Box | null {
  const sheet = context.doc.sheet[context.sheet]!;
  const rows = positions(sheet.rows).ids;
  const cols = positions(sheet.cols).ids;
  const filled = (row: number, col: number) =>
    row >= 1 &&
    col >= 1 &&
    row <= rows.length &&
    col <= cols.length &&
    context.values.value(context.sheet, rows[row - 1]!, cols[col - 1]!) !== null;
  const any = (r1: number, r2: number, c1: number, c2: number) => {
    for (let row = r1; row <= r2; row++)
      for (let col = c1; col <= c2; col++) if (filled(row, col)) return true;
    return false;
  };
  const start = selectionBox(context);
  let [top, bottom, left, right] = [start.top, start.bottom, start.left, start.right];
  if (!any(top, bottom, left, right) && !any(top - 1, bottom + 1, left - 1, right + 1)) return null;
  for (let grew = true; grew;) {
    grew = false;
    if (top > 1 && any(top - 1, top - 1, left - 1, right + 1)) [top, grew] = [top - 1, true];
    if (bottom < rows.length && any(bottom + 1, bottom + 1, left - 1, right + 1))
      [bottom, grew] = [bottom + 1, true];
    if (left > 1 && any(top, bottom, left - 1, left - 1)) [left, grew] = [left - 1, true];
    if (right < cols.length && any(top, bottom, right + 1, right + 1))
      [right, grew] = [right + 1, true];
  }
  return { r1: rows[top - 1]!, r2: rows[bottom - 1]!, c1: cols[left - 1]!, c2: cols[right - 1]! };
}

/**
 * Filter on or off, as Excel's button does: off when the sheet has one, else
 * on the selection, or on the data around a single selected cell.
 */
export function toggleFilter(context: GridContext): SheetOp[] {
  if (context.doc.sheet[context.sheet]!.filter)
    return [{ op: "filter", sh: context.sheet, filter: null }];
  const box = selectionBox(context);
  const area = box.top === box.bottom && box.left === box.right ? currentRegion(context) : box.area;
  if (!area || area.r1 === area.r2) return [];
  return [{ op: "filter", sh: context.sheet, filter: { box: area, rules: {} } }];
}

/** A column's rule set, or cleared with null, the rest of the filter kept. */
export function setFilterRule(
  context: GridContext,
  column: string,
  rule: FilterRule | null,
): SheetOp[] {
  const filter = context.doc.sheet[context.sheet]!.filter;
  if (!filter) return [];
  const { [column]: _old, ...rules } = filter.rules;
  return [
    {
      op: "filter",
      sh: context.sheet,
      filter: { ...filter, rules: rule ? { ...rules, [column]: rule } : rules },
    },
  ];
}

/**
 * The shown values a column's filter list offers, sorted, with how many
 * rows have each: only from rows the other columns' rules let through, as
 * Excel lists them.
 */
export function filterChoices(context: GridContext, column: string) {
  const filter = context.doc.sheet[context.sheet]!.filter;
  const span = filter ? filterSpan(context.doc, context.sheet, filter) : null;
  if (!filter || !span) return [];
  const { [column]: _own, ...others } = filter.rules;
  const doc = {
    ...context.doc,
    sheet: {
      ...context.doc.sheet,
      [context.sheet]: {
        ...context.doc.sheet[context.sheet]!,
        filter: { ...filter, rules: others },
      },
    },
  };
  const hidden = filteredRows(doc, context.values, context.sheet);
  const counts = new Map<string, number>();
  for (const r of span.body) {
    if (hidden.has(r)) continue;
    const shown = shownText(context.doc, context.values, context.sheet, r, column);
    counts.set(shown, (counts.get(shown) ?? 0) + 1);
  }
  // Blanks last, the rest in their natural order, numbers as numbers.
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) =>
      a.value === ""
        ? 1
        : b.value === ""
          ? -1
          : a.value.localeCompare(b.value, undefined, { numeric: true }),
    );
}

/** The filter's rows below its header sorted by one of its columns, as its menu's sort does. */
export function sortFilter(context: GridContext, column: string, descending: boolean): SheetOp[] {
  const filter = context.doc.sheet[context.sheet]!.filter;
  const span = filter ? filterSpan(context.doc, context.sheet, filter) : null;
  if (!filter || !span) return [];
  return sortRows(context, span.body, { c1: filter.box.c1, c2: filter.box.c2 }, [
    { column, descending },
  ]);
}

/** The selection's rows sorted by several columns, its first row kept as headers when asked. */
export function sortSelectionBy(
  context: GridContext,
  keys: readonly SortKey[],
  headers: boolean,
): SheetOp[] {
  const box = selectionBox(context);
  return sortRows(
    context,
    headers ? box.rowIds.slice(1) : box.rowIds,
    {
      c1: box.colIds[0]!,
      c2: box.colIds.at(-1)!,
    },
    keys,
  );
}
