// The pure halves of tables and pie charts: which order the reader's sort
// gives and which slices a pie draws. Apart from data.tsx so tests reach
// them without the chart library.

export type Cell = string | number | null;
export type Sort = { readonly column: number; readonly descending: boolean };

/** Numbers before text; text compares as a person reads it, "Item 2" before "Item 10". */
function compareCells(a: Cell, b: Cell): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number" || typeof b === "number") return typeof a === "number" ? -1 : 1;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

/** Rows in the reader's chosen order, the block's own when unsorted; blanks always last. */
export function sortRows(
  rows: readonly (readonly Cell[])[],
  sort: Sort | null,
): readonly (readonly Cell[])[] {
  if (!sort) return rows;
  const blank = (v: Cell | undefined) => v === null || v === undefined || v === "";
  return rows.toSorted((a, b) => {
    const x = a[sort.column] ?? null;
    const y = b[sort.column] ?? null;
    if (blank(x) || blank(y)) return Number(blank(x)) - Number(blank(y));
    return sort.descending ? compareCells(y, x) : compareCells(x, y);
  });
}

/** The theme's chart colours; a slice past these would repeat one, so the rest fold into Other. */
export const PIE_COLOURS = 4;

interface Slice {
  readonly name: string;
  readonly value: number;
}

/**
 * Positive slices in the block's order, one per name: a name written twice is
 * one category, and the chart colours and keys slices by name. Past four, the
 * largest four keep their colours and the rest, a slice the block named Other
 * among them, sum into one Other at the end.
 */
export function slicesOf(
  xs: readonly string[],
  values: readonly (number | null)[],
  /** The rest slice's name, in the reader's language. */
  other = "Other",
): Slice[] {
  const totals = new Map<string, number>();
  xs.forEach((name, i) => {
    const value = values[i];
    if (typeof value === "number" && value > 0) totals.set(name, (totals.get(name) ?? 0) + value);
  });
  const all = [...totals].map(([name, value]) => ({ name, value }));
  if (all.length <= PIE_COLOURS) return all;
  const kept = new Set(
    all
      .flatMap((s, i) => (s.name === other ? [] : [i]))
      .toSorted((a, b) => all[b]!.value - all[a]!.value || a - b)
      .slice(0, PIE_COLOURS),
  );
  const rest = all.filter((_, i) => !kept.has(i)).reduce((sum, s) => sum + s.value, 0);
  return [...all.filter((_, i) => kept.has(i)), { name: other, value: rest }];
}
