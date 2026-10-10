import { columnLetters, parseRange } from "@chat/sheet/a1";
import { XError, type Scalar } from "@chat/sheet/engine/values";
import { sheetLocale } from "@chat/sheet/locales";
import type { SheetValues } from "@chat/sheet/model/calc";
import { quoteSheet, renderFormula } from "@chat/sheet/model/formula";
import { liveSheets, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import type { ChartText } from "@chat/sheet/model/chart";
import { filterSpan, filteredRows } from "@chat/sheet/model/filter";
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
  // The focused sheet's conditional formats, first taking priority.
  const conditional = (doc.sheet[sheet]!.conditional ?? []).flatMap((format) => {
    const [rowsAt, colsAt] = [positions(doc.sheet[sheet]!.rows), positions(doc.sheet[sheet]!.cols)];
    const [top, left, bottom, right] = [
      rowsAt.at(format.box.r1),
      colsAt.at(format.box.c1),
      rowsAt.at(format.box.r2),
      colsAt.at(format.box.c2),
    ];
    if (!top || !left || !bottom || !right) return [];
    const rule = format.rule;
    const style = "style" in rule ? rule.style : {};
    const said =
      rule.kind === "compare"
        ? `${rule.op} ${rule.values.join(" and ")}`
        : rule.kind === "text"
          ? `text ${rule.op} ${rule.text}`
          : rule.kind === "top"
            ? `${rule.bottom ? "bottom" : "top"} ${rule.count}${rule.percent ? "%" : ""}`
            : rule.kind === "average"
              ? rule.below
                ? "belowAverage"
                : "aboveAverage"
              : rule.kind === "duplicate"
                ? rule.unique
                  ? "unique"
                  : "duplicate"
                : rule.kind === "blank"
                  ? rule.not
                    ? "notBlank"
                    : "blank"
                  : rule.kind === "scale"
                    ? `colorScale ${rule.colors.join(" ")}`
                    : `dataBar ${rule.color}`;
    const looks = [
      style.fill && `fill="${style.fill}"`,
      style.fontColor && `fontColor="${style.fontColor}"`,
      style.bold && "bold",
      style.italic && "italic",
    ].filter(Boolean);
    return [
      `<rule range="${address(top, left)}:${address(bottom, right)}" is="${escapeAttribute(said)}"${looks.length ? ` ${looks.join(" ")}` : ""}/>`,
    ];
  });
  if (conditional.length)
    lines.push(`<conditionalFormats>\n${conditional.join("\n")}\n</conditionalFormats>`);
  // The focused sheet's filter and what it hides, so the model does not take hidden rows for gone.
  const filter = doc.sheet[sheet]!.filter;
  const span = filter ? filterSpan(doc, sheet, filter) : null;
  if (filter && span) {
    const sheetRows = positions(doc.sheet[sheet]!.rows);
    const sheetCols = positions(doc.sheet[sheet]!.cols);
    const top = sheetRows.at(span.header)!;
    const left = sheetCols.at(span.columns[0]!)!;
    const rules = Object.entries(filter.rules).flatMap(([column, rule]) => {
      const at = sheetCols.at(column);
      if (at === undefined) return [];
      const parts = [
        `column="${columnLetters(at)}"`,
        ...(rule.values
          ? [`keep="${escapeAttribute(rule.values.map((each) => each || "(blank)").join(", "))}"`]
          : []),
        ...(rule.condition
          ? [
              `condition="${rule.condition.op}"`,
              ...(rule.condition.value === undefined
                ? []
                : [`value="${escapeAttribute(String(rule.condition.value))}"`]),
            ]
          : []),
      ];
      return [`  <rule ${parts.join(" ")}/>`];
    });
    const hiding = filteredRows(doc, values, sheet).size;
    lines.push(
      `<filter range="${address(top, left)}:${address(top + span.body.length, left + span.columns.length - 1)}" hides="${hiding} rows">${rules.length ? `\n${rules.join("\n")}\n` : ""}</filter>`,
    );
  }
  /** A range by IDs as A1, named with its sheet; null when its rows or columns are gone. */
  const rangeText = (on: string, area: { r1: string; r2: string; c1: string; c2: string }) => {
    const data = doc.sheet[on];
    if (!data) return null;
    const rows = positions(data.rows);
    const cols = positions(data.cols);
    const [top, bottom, left, right] = [
      rows.at(area.r1),
      rows.at(area.r2),
      cols.at(area.c1),
      cols.at(area.c2),
    ];
    if (!top || !bottom || !left || !right) return null;
    return `${quoteSheet(data.name)}!${address(top, left)}:${address(bottom, right)}`;
  };
  /** A chart's text as written, or the cell it reads, as a reference. */
  const chartText = (label: ChartText | undefined) => {
    if (!label) return null;
    if ("text" in label) return label.text;
    const data = doc.sheet[label.cell.sh];
    const row = data ? positions(data.rows).at(label.cell.r) : undefined;
    const col = data ? positions(data.cols).at(label.cell.c) : undefined;
    return data && row && col ? `=${quoteSheet(data.name)}!${address(row, col)}` : "#REF!";
  };
  /** Attributes from the options set, in order; true is written bare, unset ones left out. */
  const attributes = (
    pairs: ReadonlyArray<readonly [string, string | number | boolean | null | undefined]>,
  ) =>
    pairs
      .flatMap(([key, value]) =>
        value === undefined || value === null || value === false
          ? []
          : [value === true ? key : `${key}="${escapeAttribute(String(value))}"`],
      )
      .join(" ");
  const charts = Object.entries(doc.charts).flatMap(([id, chart]) => {
    const host = doc.sheet[chart.sheet];
    if (!host || !ids.includes(chart.sheet)) return [];
    const row = positions(host.rows).at(chart.at.r);
    const col = positions(host.cols).at(chart.at.c);
    const head = attributes([
      ["id", id],
      ["sheet", host.name],
      ["type", chart.kind],
      ["at", row && col ? address(row, col) : null],
      ["size", `${chart.size.width}x${chart.size.height}`],
      ["range", chart.source ? (rangeText(chart.source.sheet, chart.source.box) ?? "#REF!") : null],
      ["stack", chart.stack],
      ["title", chartText(chart.title)],
      ["subtitle", chartText(chart.subtitle)],
      ["legend", chart.legend],
      ["labels", chart.style?.labels?.show],
      ["hole", chart.style?.hole],
    ]);
    const series = chart.series.map((each) => {
      const on = each.sheet ?? chart.sheet;
      return `  <series ${attributes([
        ["values", rangeText(on, each.values) ?? "#REF!"],
        ["name", chartText(each.name)],
        ["categories", each.categories ? (rangeText(on, each.categories) ?? "#REF!") : null],
        ["sizes", each.sizes ? (rangeText(on, each.sizes) ?? "#REF!") : null],
        ["color", each.color],
        ["as", each.kind],
        ["axis", each.axis],
        ["labels", each.labels?.show],
        ["smooth", each.line?.smooth],
        ["markers", each.line?.markers],
        ["dashed", each.line?.dashed],
        ["trendline", each.trendline],
      ])}/>`;
    });
    const axes = (["x", "y", "y2"] as const).flatMap((key) => {
      const axis = chart.axes?.[key];
      if (!axis) return [];
      const tag = key === "x" ? "xAxis" : key === "y" ? "yAxis" : "rightAxis";
      return [
        `  <${tag} ${attributes([
          ["title", chartText(axis.title)],
          ["min", axis.min],
          ["max", axis.max],
          ["format", axis.format],
          ["log", axis.log],
          ["gridlines", axis.gridlines],
        ])}/>`,
      ];
    });
    return [`<chart ${head}>\n${[...series, ...axes].join("\n")}\n</chart>`];
  });
  if (charts.length) lines.push(`<charts>\n${charts.join("\n")}\n</charts>`);
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
