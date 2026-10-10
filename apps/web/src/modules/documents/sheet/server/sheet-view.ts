import { columnLetters, parseRange } from "@chat/sheet/a1";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import { sheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { liveSheets, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import { formatValue } from "@chat/sheet/number-format";

/** Above this the focused sheet is sent as a window of rows. */
export const SHEET_VIEW_CHARS = 24_000;
/** Text past this in one cell is cut, saying how much more there is. */
const CELL_CHARS = 300;

/** Where the model is reading: a sheet, and a range on it (default: what it uses). */
export interface SheetWindow {
  readonly sheet?: string;
  readonly range?: string;
}

const escapeAttribute = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const text = (value: Scalar) => {
  if (value === null) return "(empty)";
  if (value instanceof XError) return value.code;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return String(value);
  return JSON.stringify(
    value.length > CELL_CHARS
      ? `${value.slice(0, CELL_CHARS)}… (${value.length - CELL_CHARS} more characters)`
      : value,
  );
};
/** A style key as reader-facing properties: `bold numberFormat="0%"`. */
const styleText = (key: string) =>
  Object.entries(JSON.parse(key) as Record<string, unknown>)
    .map(([name, value]) => (value === true ? name : `${name}=${JSON.stringify(value)}`))
    .join(" ");
const address = (row: number, col: number) => `${columnLetters(col)}${row}`;

/** The part of a sheet holding anything: typed cells and what formulas spill into. */
function usedBox(doc: SheetDoc, values: SheetValues, sheet: string) {
  const rows = positions(doc.sheet[sheet]!.rows);
  const cols = positions(doc.sheet[sheet]!.cols);
  let [bottom, right] = [0, 0];
  for (const [r, row] of Object.entries(doc.sheet[sheet]!.cells)) {
    const top = rows.at(r);
    if (top === undefined) continue;
    for (const [c, cell] of Object.entries(row)) {
      const left = cols.at(c);
      if (left === undefined || (cell.v === undefined && !cell.f)) continue;
      const spill = cell.f ? values.spill(sheet, r, c) : null;
      bottom = Math.max(bottom, top + (spill ? spill.rows.length - 1 : 0));
      right = Math.max(right, left + (spill ? spill.cols.length - 1 : 0));
    }
  }
  return bottom ? { top: 1, left: 1, bottom, right } : null;
}

/**
 * A sheet as the model reads it: its tabs, then one window of cells, a line
 * per row that holds anything, with formulas beside what they calculate and
 * a number's shown text where its format changes it. Formats, merges and
 * names follow. `next` is where a cut-off window goes on.
 */
export function sheetView(
  doc: SheetDoc,
  values: SheetValues,
  window: SheetWindow = {},
  budget = SHEET_VIEW_CHARS,
): { xml: string; next: SheetWindow | null; sheet: string } {
  const ids = liveSheets(doc);
  const sheet = (window.sheet && sheetNamed(doc, window.sheet)) || ids[0]!;
  const name = doc.sheet[sheet]!.name;
  const locale = sheetLocale(doc.settings.locale);
  const tabs = ids.map((id) => {
    const used = usedBox(doc, values, id);
    const { freeze } = doc.sheet[id]!;
    const frozenRow = freeze.row ? positions(doc.sheet[id]!.rows).at(freeze.row) : undefined;
    const frozenCol = freeze.col ? positions(doc.sheet[id]!.cols).at(freeze.col) : undefined;
    const attributes = [
      `name="${escapeAttribute(doc.sheet[id]!.name)}"`,
      used ? `used="A1:${address(used.bottom, used.right)}"` : `used="none"`,
      frozenRow || frozenCol
        ? `frozen="${address((frozenRow ?? 0) + 1, (frozenCol ?? 0) + 1)}"`
        : "",
      id === sheet ? "shown" : "",
    ].filter(Boolean);
    return `<tab ${attributes.join(" ")}/>`;
  });
  const lines = [`<tabs locale="${doc.settings.locale}">`, ...tabs, "</tabs>"];

  const rowIds = positions(doc.sheet[sheet]!.rows).ids;
  const colIds = positions(doc.sheet[sheet]!.cols).ids;
  const asked = window.range ? parseRange(window.range) : null;
  const used = usedBox(doc, values, sheet);
  const box = asked
    ? {
        top: asked.top,
        left: asked.left,
        bottom: Math.min(asked.bottom, rowIds.length),
        right: Math.min(asked.right, colIds.length),
      }
    : used;
  let next: SheetWindow | null = null;
  const styles = new Map<string, Array<{ row: number; from: number; to: number }>>();
  if (!box || box.top > box.bottom || box.left > box.right)
    lines.push(`<cells sheet="${escapeAttribute(name)}" range="none"/>`);
  else {
    lines.push(
      `<cells sheet="${escapeAttribute(name)}" range="${address(box.top, box.left)}:${address(box.bottom, box.right)}">`,
    );
    let size = lines.join("\n").length;
    for (let row = box.top; row <= box.bottom; row++) {
      const r = rowIds[row - 1]!;
      const cells: string[] = [];
      let run: { key: string; from: number } | null = null;
      const closeRun = (to: number) => {
        if (!run) return;
        const list = styles.get(run.key) ?? [];
        list.push({ row, from: run.from, to });
        styles.set(run.key, list);
        run = null;
      };
      for (let col = box.left; col <= box.right; col++) {
        const c = colIds[col - 1]!;
        const cell = doc.sheet[sheet]!.cells[r]?.[c];
        const key = cell?.s ?? null;
        if (run && run.key !== key) closeRun(col - 1);
        if (key && !run) run = { key, from: col };
        const value = values.value(sheet, r, c);
        if (!cell?.f && value === null) continue;
        let shown = text(value);
        const format = key ? (JSON.parse(key) as { numberFormat?: unknown }).numberFormat : null;
        if (typeof format === "string" && !(value instanceof XError)) {
          const formatted = formatValue(value, format, locale)?.text;
          if (formatted !== undefined && formatted !== String(value))
            shown += ` (${JSON.stringify(formatted)})`;
        }
        cells.push(
          cell?.f
            ? `${address(row, col)} =${renderFormula(cell.f, { doc, sheet })} → ${shown}`
            : `${address(row, col)} ${shown}`,
        );
      }
      closeRun(box.right);
      if (!cells.length) continue;
      const line = `${row}| ${cells.join(" | ")}`;
      if (size + line.length > budget && row > box.top) {
        next = {
          sheet: name,
          range: `${address(row, box.left)}:${address(box.bottom, box.right)}`,
        };
        break;
      }
      lines.push(line);
      size += line.length + 1;
    }
    lines.push("</cells>");
  }

  // Runs on consecutive rows with the same columns read as one rectangle.
  const formats: string[] = [];
  for (const [key, runs] of styles) {
    const merged: Array<{ top: number; bottom: number; from: number; to: number }> = [];
    for (const run of runs) {
      const open = merged.find(
        (each) => each.bottom === run.row - 1 && each.from === run.from && each.to === run.to,
      );
      if (open) open.bottom = run.row;
      else merged.push({ top: run.row, bottom: run.row, from: run.from, to: run.to });
    }
    const where = merged.map((each) =>
      each.top === each.bottom && each.from === each.to
        ? address(each.top, each.from)
        : `${address(each.top, each.from)}:${address(each.bottom, each.to)}`,
    );
    formats.push(`${where.join(",")} ${styleText(key)}`);
  }
  if (formats.length) lines.push(`<formats>\n${formats.join("\n")}\n</formats>`);
  const merges = doc.sheet[sheet]!.merges.flatMap((merge) => {
    const rows = positions(doc.sheet[sheet]!.rows);
    const cols = positions(doc.sheet[sheet]!.cols);
    const [top, bottom, left, right] = [
      rows.at(merge.r1),
      rows.at(merge.r2),
      cols.at(merge.c1),
      cols.at(merge.c2),
    ];
    return top && bottom && left && right
      ? [`${address(top, left)}:${address(bottom, right)}`]
      : [];
  });
  if (merges.length) lines.push(`<merges>${merges.join(" ")}</merges>`);
  const names = Object.values(doc.names).map(
    (each) => `${each.name}=${renderFormula(each.f, { doc, sheet: ids[0]! })}`,
  );
  if (names.length) lines.push(`<names>${escapeAttribute(names.join(" "))}</names>`);
  if (values.report.errorCount)
    lines.push(
      `<errors count="${values.report.errorCount}">${values.report.errors
        .slice(0, 10)
        .map((issue) => escapeAttribute(`${issue.cell} ${issue.error}`))
        .join("; ")}</errors>`,
    );
  return { xml: lines.join("\n"), next, sheet: name };
}
