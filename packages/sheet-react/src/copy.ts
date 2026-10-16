import type { Scalar } from "@chat/sheet/engine/values";
import type { SheetLocale } from "@chat/sheet/locales";
import { cellStyle } from "@chat/sheet/style";
import { cellDisplay } from "./display.ts";
import type { GridSheet } from "./grid-model.ts";
import type { SheetSelection } from "./selection.ts";

/** The most cells one copy reads; a sparse sheet can make a selection span billions. */
export const COPY_CELLS = 1_000_000;

/** Quoted as Excel quotes a field, so a cell holding a tab or a line break pastes as one cell. */
const field = (text: string) => (/[\t\n\r"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);

/**
 * The selection's active range as it shows, a tab between cells and a line
 * per row, as Excel copies it as text. Hidden rows and columns are left out,
 * and so are empty ones at the end. Null when the range is over `COPY_CELLS`.
 */
export function selectionText(
  sheet: GridSheet,
  value: (r: string, c: string) => Scalar,
  locale: SheetLocale,
  selection: SheetSelection,
) {
  const [r1, r2] = [sheet.rows.indexOf(selection.anchor.r), sheet.rows.indexOf(selection.head.r)];
  const [c1, c2] = [sheet.cols.indexOf(selection.anchor.c), sheet.cols.indexOf(selection.head.c)];
  if (r1 < 0 || r2 < 0 || c1 < 0 || c2 < 0) return "";
  const rows = sheet.rows
    .slice(Math.min(r1, r2), Math.max(r1, r2) + 1)
    .filter((r) => !sheet.rowProps[r]?.hidden);
  const cols = sheet.cols
    .slice(Math.min(c1, c2), Math.max(c1, c2) + 1)
    .filter((c) => !sheet.colProps[c]?.hidden);
  if (rows.length * cols.length > COPY_CELLS) return null;
  const lines = rows.map((r) =>
    cols.map((c) => {
      const held = value(r, c);
      return held === null ? "" : cellDisplay(held, cellStyle(sheet.cells[r]?.[c]?.s), locale).text;
    }),
  );
  // One cell is copied as it is, even empty; a range drops its empty trailing rows and columns.
  let height = lines.length;
  while (height > 1 && lines[height - 1]!.every((text) => text === "")) height--;
  const kept = lines.slice(0, height);
  let width = cols.length;
  while (width > 1 && kept.every((line) => line[width - 1] === "")) width--;
  return kept.map((line) => line.slice(0, width).map(field).join("\t")).join("\n");
}
