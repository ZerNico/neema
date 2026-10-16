import type { Scalar } from "@chat/sheet/engine/values";
import type { GridSheet } from "./grid-model.ts";
import type { AxisLayout } from "./layout.ts";

/**
 * The occupied columns of a row, sorted, built on first ask. A leftward spill search then costs a
 * row's own cells, not the empty distance back to column A.
 */
export function occupiedColumns(
  cells: GridSheet["cells"],
  value: (r: string, c: string) => Scalar,
  rows: AxisLayout,
  cols: AxisLayout,
) {
  let colIndex: Map<string, number> | undefined;
  const byRow = new Map<number, readonly number[]>();
  return (row: number): readonly number[] => {
    const known = byRow.get(row);
    if (known) return known;
    colIndex ??= new Map(cols.ids.map((id, index) => [id, index]));
    const r = rows.ids[row]!;
    const found = new Set<number>();
    for (const c of Object.keys(cells[r] ?? {})) {
      const col = colIndex.get(c);
      if (col !== undefined && cols.size(col) && value(r, c) !== null) found.add(col);
    }
    const sorted = [...found].toSorted((a, b) => a - b);
    byRow.set(row, sorted);
    return sorted;
  };
}

export function precedingColumn(columns: readonly number[], before: number) {
  let low = 0;
  let high = columns.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (columns[middle]! < before) low = middle + 1;
    else high = middle;
  }
  return columns[low - 1] ?? -1;
}
