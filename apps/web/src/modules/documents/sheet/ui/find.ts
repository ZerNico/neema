import type { SheetLocale } from "@chat/sheet/locales";
import type { Positions, SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import { cellStyle } from "@chat/sheet/model/style";
import { cellDisplay, cellSource } from "@chat/sheet-react/display";

/** A cell Find matched, by IDs and by its row and column numbers. */
export interface FindMatch {
  readonly r: string;
  readonly c: string;
  readonly row: number;
  readonly col: number;
}

/** Cells on a sheet whose shown text or formula holds the query, in reading order. */
export function findMatches(
  of: {
    doc: SheetDoc;
    values: SheetValues;
    sheet: string;
    locale: SheetLocale;
    rows: Positions;
    cols: Positions;
  },
  query: string,
): FindMatch[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];
  const { doc, values, sheet, locale, rows, cols } = of;
  const found: FindMatch[] = [];
  for (const [r, row] of Object.entries(doc.sheet[sheet]!.cells)) {
    const rowAt = rows.at(r);
    if (rowAt === undefined) continue;
    for (const [c, cell] of Object.entries(row)) {
      const colAt = cols.at(c);
      if (colAt === undefined) continue;
      const shown = cellDisplay(values.value(sheet, r, c), cellStyle(cell.s), locale).text;
      const formula = cell.f ? cellSource(doc, sheet, r, c, locale) : "";
      if (shown.toLowerCase().includes(wanted) || formula.toLowerCase().includes(wanted))
        found.push({ r, c, row: rowAt, col: colAt });
    }
  }
  return found.toSorted((a, b) => a.row - b.row || a.col - b.col);
}
