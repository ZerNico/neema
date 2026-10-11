import { boxRef, parseRange, type CellBox } from "@chat/sheet/a1";
import { sheetLocale } from "@chat/sheet/locales";
import { positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import { quoteSheet } from "@chat/sheet/model/formula";
import { cellStyle } from "@chat/sheet/model/style";
import { cellDisplay } from "@chat/sheet-react/display";

/**
 * How much of a range a text document draws: enough for a summary table,
 * little enough that a whole column embedded by mistake stays one screen.
 */
export const EMBED_CAP = { rows: 50, cols: 12 } as const;

/** `Data!A1:D9` or `'My data'!B2` as a sheet name and a box, or null. */
export const splitRange = (text: string) => {
  const at = text.lastIndexOf("!");
  if (at < 1) return null;
  const written = text.slice(0, at);
  const name = /^'.*'$/.test(written) ? written.slice(1, -1).replaceAll("''", "'") : written;
  const box = parseRange(text.slice(at + 1));
  return box && name ? { name, box } : null;
};

/** A range as an embed names it: the sheet's name, quoted as a formula would, then A1. */
export const rangeText = (name: string, box: CellBox) => `${quoteSheet(name)}!${boxRef(box)}`;

export interface EmbedCell {
  readonly text: string;
  readonly align: "left" | "center" | "right";
  readonly bold: boolean;
  readonly italic: boolean;
}
export interface EmbedTable {
  readonly rows: ReadonlyArray<ReadonlyArray<EmbedCell>>;
  /** The rows' and columns' IDs, in the order drawn. */
  readonly rowIds: readonly string[];
  readonly colIds: readonly string[];
  /** Rows and columns past the cap, left out. */
  readonly more: { readonly rows: number; readonly cols: number };
}

/**
 * A range's cells as they show in the sheet, in its locale, hidden rows and
 * columns left out, cut at `cap`. Null when the sheet is gone or renamed, or
 * the range starts past its grid; one reaching past the grid is cut there.
 */
export function embedTable(
  doc: SheetDoc,
  values: SheetValues,
  range: string,
  cap: { rows: number; cols: number } = EMBED_CAP,
): EmbedTable | null {
  const parsed = splitRange(range);
  const id = parsed ? sheetNamed(doc, parsed.name) : undefined;
  if (!parsed || !id) return null;
  const sheet = doc.sheet[id]!;
  const rows = positions(sheet.rows).ids;
  const cols = positions(sheet.cols).ids;
  const { box } = parsed;
  if (box.top > rows.length || box.left > cols.length) return null;
  const rowIds = rows.slice(box.top - 1, box.bottom).filter((r) => !sheet.rowProps[r]?.hidden);
  const colIds = cols.slice(box.left - 1, box.right).filter((c) => !sheet.colProps[c]?.hidden);
  const locale = sheetLocale(doc.settings.locale);
  const cell = (r: string, c: string): EmbedCell => {
    const style = cellStyle(sheet.cells[r]?.[c]?.s);
    const shown = cellDisplay(values.value(id, r, c), style, locale);
    return {
      text: shown.text,
      align: shown.align,
      bold: style.bold === true,
      italic: style.italic === true,
    };
  };
  const shownRows = rowIds.slice(0, cap.rows);
  const shownCols = colIds.slice(0, cap.cols);
  return {
    rows: shownRows.map((r) => shownCols.map((c) => cell(r, c))),
    rowIds: shownRows,
    colIds: shownCols,
    more: {
      rows: Math.max(0, rowIds.length - cap.rows),
      cols: Math.max(0, colIds.length - cap.cols),
    },
  };
}

/** Says what a cut table left out, or null when it shows the whole range. */
export const embedMoreText = (table: EmbedTable) => {
  const { rows, cols } = table.more;
  if (!rows && !cols) return null;
  const shown = [
    rows ? `${table.rows.length} rows` : null,
    cols ? `${table.rows[0]?.length ?? 0} columns` : null,
  ].filter(Boolean);
  return `Showing the first ${shown.join(" and ")}`;
};
