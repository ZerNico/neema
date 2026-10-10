import type { SheetValues } from "@chat/sheet/model/calc";
import { collapsedIds } from "@chat/sheet/model/outline";
import { filteredRows } from "@chat/sheet/model/filter";
import type { SheetLocale } from "@chat/sheet/locales";
import { positions, type SheetDoc } from "@chat/sheet/model";
import { cellHtml } from "./clipboard.ts";
import { columnPx } from "./layout.ts";

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A sheet as a page to print, as Excel prints its used range: the cells that
 * hold anything, as they show, at their widths, with light gridlines. Rows
 * and columns hidden, filtered out or collapsed are left out. Null when the
 * sheet is empty.
 */
export function printHtml(
  context: { doc: SheetDoc; values: SheetValues; locale: SheetLocale },
  sheetId: string,
): string | null {
  const sheet = context.doc.sheet[sheetId]!;
  const rows = positions(sheet.rows);
  const cols = positions(sheet.cols);
  let [bottom, right] = [0, 0];
  for (const [r, row] of Object.entries(sheet.cells))
    for (const c of Object.keys(row))
      if (context.values.value(sheetId, r, c) !== null) {
        bottom = Math.max(bottom, rows.at(r) ?? 0);
        right = Math.max(right, cols.at(c) ?? 0);
      }
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
  const body = shownRows
    .map((r) => `<tr>${shownCols.map((c) => cellHtml(at, r, c, true)).join("")}</tr>`)
    .join("");
  const widths = shownCols
    .map((c) => `<col style="width:${columnPx(sheet.colProps[c])}px">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(sheet.name)}</title><style>
@page { margin: 12mm; }
body { margin: 0; font: 11pt Calibri, Aptos, Arial, sans-serif; color: #000; }
table { border-collapse: collapse; table-layout: fixed; }
td { border: 1px solid #d4d4d4; padding: 1px 4px; white-space: pre; overflow: hidden; vertical-align: bottom; }
tr { break-inside: avoid; }
</style></head><body><table><colgroup>${widths}</colgroup><tbody>${body}</tbody></table></body></html>`;
}
