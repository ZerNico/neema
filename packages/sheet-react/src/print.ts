import type { SheetValues } from "@chat/sheet/model/calc";
import { collapsedIds } from "@chat/sheet/model/outline";
import { filteredRows } from "@chat/sheet/model/filter";
import type { SheetLocale } from "@chat/sheet/locales";
import { positions, type SheetDoc } from "@chat/sheet/model";
import { cellHtml } from "./clipboard.ts";
import { usedExtent } from "./commands.ts";
import { columnPx } from "./layout.ts";

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A sheet as a page to print, as Excel prints its used range: the cells that
 * hold anything, as they show, at their widths, with light gridlines. Rows
 * and columns hidden, filtered out or collapsed are left out. Null when the
 * sheet is empty. The page has no margin of its own, the body keeps it, so
 * the browser prints no header or footer (its URL, title and date).
 */
export function printHtml(
  context: { doc: SheetDoc; values: SheetValues; locale: SheetLocale },
  sheetId: string,
): string | null {
  const sheet = context.doc.sheet[sheetId]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  const { bottom, right } = usedExtent(context, sheetId);
  if (!bottom) return null;
  const skipRows = new Set([
    ...filteredRows(context.doc, context.values, sheetId),
    ...collapsedIds(context.doc, sheetId, "rows"),
  ]);
  const skipCols = collapsedIds(context.doc, sheetId, "columns");
  const shownRows = rows.ids
    .slice(0, bottom)
    .filter((r) => !sheet.rowProps[r]?.hidden && !skipRows.has(r));
  const shownCols = cols.ids
    .slice(0, right)
    .filter((c) => !sheet.colProps[c]?.hidden && !skipCols.has(c));
  const at = { ...context, sheet: sheetId };
  // A merge prints as one cell over its shown rows and columns, holding its first cell's content.
  const [rowSet, colSet] = [new Set(shownRows), new Set(shownCols)];
  const merged = new Map<string, { r: string; c: string; rows: number; cols: number } | null>();
  for (const box of sheet.merges) {
    const rowsIn = rows.ids
      .slice((rows.at(box.r1) ?? 1) - 1, rows.at(box.r2) ?? 0)
      .filter((r) => rowSet.has(r));
    const colsIn = cols.ids
      .slice((cols.at(box.c1) ?? 1) - 1, cols.at(box.c2) ?? 0)
      .filter((c) => colSet.has(c));
    if (!rowsIn.length || !colsIn.length) continue;
    for (const r of rowsIn) for (const c of colsIn) merged.set(`${r}|${c}`, null);
    merged.set(`${rowsIn[0]}|${colsIn[0]}`, {
      r: box.r1,
      c: box.c1,
      rows: rowsIn.length,
      cols: colsIn.length,
    });
  }
  const cell = (r: string, c: string) => {
    const merge = merged.get(`${r}|${c}`);
    if (merge === undefined) return cellHtml(at, r, c, true);
    return merge ? cellHtml(at, merge.r, merge.c, true, merge) : "";
  };
  const body = shownRows
    .map((r) => `<tr>${shownCols.map((c) => cell(r, c)).join("")}</tr>`)
    .join("");
  const widths = shownCols
    .map((c) => `<col style="width:${columnPx(sheet.colProps[c])}px">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sheet.name)}</title><style>
@page { margin: 0; }
body { margin: 0; padding: 12mm; font: 11pt Calibri, Aptos, Arial, sans-serif; color: #000; }
table { border-collapse: collapse; table-layout: fixed; }
td { border: 1px solid #d4d4d4; padding: 1px 4px; white-space: pre; overflow: hidden; vertical-align: bottom; }
tr { break-inside: avoid; }
</style></head><body><table><colgroup>${widths}</colgroup><tbody>${body}</tbody></table></body></html>`;
}
