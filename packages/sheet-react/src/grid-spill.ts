import type { Sheet } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { AxisLayout } from "./layout.ts";

/**
 * The occupied columns of a row, sorted, built on first ask. A leftward spill search then costs a
 * row's own cells, not the empty distance back to column A, and an edit pays nothing until a band
 * scrolled right asks.
 */
export function occupiedColumns(
  sheet: string,
  cells: Sheet["cells"],
  values: SheetValues,
  rows: AxisLayout,
  cols: AxisLayout,
) {
  let colIndex: Map<string, number> | undefined;
  let spilled: Map<string, string[]> | undefined;
  const byRow = new Map<number, readonly number[]>();
  // Spill results have no stored cells of their own, but can overflow or block text.
  const spills = () => {
    if (spilled) return spilled;
    spilled = new Map();
    for (const [r, row] of Object.entries(cells))
      for (const [c, cell] of Object.entries(row)) {
        const spill = cell.f ? values.spill(sheet, r, c) : null;
        if (!spill) continue;
        for (const sr of spill.rows) {
          const into = spilled.get(sr) ?? [];
          for (const sc of spill.cols) if (sr !== r || sc !== c) into.push(sc);
          spilled.set(sr, into);
        }
      }
    return spilled;
  };
  return (row: number): readonly number[] => {
    const known = byRow.get(row);
    if (known) return known;
    colIndex ??= new Map(cols.ids.map((id, index) => [id, index]));
    const r = rows.ids[row]!;
    const found = new Set<number>();
    for (const c of [...Object.keys(cells[r] ?? {}), ...(spills().get(r) ?? [])]) {
      const col = colIndex.get(c);
      if (col !== undefined && cols.size(col) && values.value(sheet, r, c) !== null) found.add(col);
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
