import { XError, type Scalar } from "../engine/values.ts";
import { sheetLocale } from "../locales.ts";
import { formatValue, generalText } from "../number-format.ts";
import type { SheetValues } from "./calc.ts";
import { positions, type Box, type SheetDoc } from "./model.ts";

/**
 * A chart, kept as data: what it draws from, by IDs, and every option a
 * person or the model set. Each replica draws it from the cells' current
 * values; the app compiles it for its chart library and the Excel export
 * for Excel.
 */
export const CHART_KINDS = [
  "column",
  "bar",
  "line",
  "area",
  "pie",
  "doughnut",
  "scatter",
  "bubble",
  "waterfall",
  "histogram",
] as const;
export type ChartKind = (typeof CHART_KINDS)[number];
export type SeriesKind = "column" | "line" | "area";
export type ChartStack = "none" | "stacked" | "percent";
export type LegendPlace = "none" | "top" | "bottom" | "left" | "right";
export interface CellAt {
  readonly sh: string;
  readonly r: string;
  readonly c: string;
}
/** Fixed text, or a cell's shown text, which follows the cell as it changes. */
export type ChartText = { readonly text: string } | { readonly cell: CellAt };
export interface ChartLabels {
  readonly show: boolean;
  readonly content?: "value" | "percent" | "category";
  /** An Excel number format; absent, the cells' own. */
  readonly format?: string;
}
export interface ChartAxis {
  readonly title?: ChartText;
  readonly min?: number;
  readonly max?: number;
  readonly log?: boolean;
  readonly format?: string;
  readonly gridlines?: boolean;
  readonly reverse?: boolean;
  readonly hidden?: boolean;
}
export interface ChartLine {
  readonly smooth?: boolean;
  readonly step?: boolean;
  readonly markers?: boolean;
  readonly dashed?: boolean;
}
export interface ChartSeries {
  /** The sheet its ranges are on; the chart's own when absent. */
  readonly sheet?: string;
  readonly values: Box;
  /** Point labels, or a scatter's x values. */
  readonly categories?: Box;
  /** A bubble's sizes. */
  readonly sizes?: Box;
  readonly name?: ChartText;
  /** In a column, line or area chart: drawn as another of those, making a combo. */
  readonly kind?: SeriesKind;
  readonly axis?: "left" | "right";
  readonly color?: string;
  readonly line?: ChartLine;
  readonly labels?: ChartLabels;
  readonly trendline?: boolean;
}
/** The range a chart was made from, and how it was read: what the editor rebuilds series from. */
export interface ChartSource {
  readonly sheet: string;
  readonly box: Box;
  readonly headers: boolean;
  readonly labels: boolean;
  readonly byRow: boolean;
}
export interface ChartStyle {
  readonly palette?: string;
  /** A doughnut's hole, as a share of its radius. */
  readonly hole?: number;
  /** Space between bar groups, as a share of a band. */
  readonly gap?: number;
  readonly labels?: ChartLabels;
}
export interface Chart {
  readonly sheet: string;
  /** Anchored to a cell by IDs, so it moves with inserts and deletes above and before it. */
  readonly at: { readonly r: string; readonly c: string };
  readonly size: { readonly width: number; readonly height: number };
  readonly kind: ChartKind;
  readonly stack?: ChartStack;
  readonly title?: ChartText;
  readonly subtitle?: ChartText;
  readonly legend?: LegendPlace;
  readonly axes?: { readonly x?: ChartAxis; readonly y?: ChartAxis; readonly y2?: ChartAxis };
  readonly series: readonly ChartSeries[];
  readonly source?: ChartSource;
  readonly style?: ChartStyle;
}
/** A change to some of a chart's options; null removes one. Series are replaced whole. */
export type ChartPatch = {
  readonly [K in Exclude<keyof Chart, "series" | "axes" | "style">]?: Chart[K] | null;
} & {
  readonly series?: readonly ChartSeries[];
  readonly axes?: { readonly [K in "x" | "y" | "y2"]?: ChartAxis | null };
  readonly style?: { readonly [K in keyof ChartStyle]?: ChartStyle[K] | null };
};

export const CHART_LIMITS = {
  series: 12,
  points: 500,
  /** A histogram counts more values than a chart draws points. */
  histogramValues: 20_000,
  text: 200,
  width: { min: 160, max: 2000 },
  height: { min: 120, max: 1600 },
} as const;

// ---- validation, as the transport and the model's tools need it

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 64;
const isBox = (value: unknown) =>
  isRecord(value) && isId(value.r1) && isId(value.r2) && isId(value.c1) && isId(value.c2);
const isText = (value: unknown) =>
  isRecord(value) &&
  ((typeof value.text === "string" && value.text.length <= CHART_LIMITS.text) ||
    (isRecord(value.cell) && isId(value.cell.sh) && isId(value.cell.r) && isId(value.cell.c)));
const isColor = (value: unknown) => typeof value === "string" && /^#[0-9A-Fa-f]{6}$/.test(value);
const isFormat = (value: unknown) => typeof value === "string" && value.length <= 100;
const isFinite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const optional = (value: unknown, check: (each: unknown) => boolean) =>
  value === undefined || check(value);
const oneOf =
  (...options: readonly string[]) =>
  (value: unknown) =>
    typeof value === "string" && options.includes(value);
const isBool = (value: unknown) => typeof value === "boolean";
const isLabels = (value: unknown) =>
  isRecord(value) &&
  isBool(value.show) &&
  optional(value.content, oneOf("value", "percent", "category")) &&
  optional(value.format, isFormat);
const isAxis = (value: unknown) =>
  isRecord(value) &&
  optional(value.title, isText) &&
  optional(value.min, isFinite) &&
  optional(value.max, isFinite) &&
  optional(value.format, isFormat) &&
  ["log", "gridlines", "reverse", "hidden"].every((key) => optional(value[key], isBool));
const isSeries = (value: unknown) =>
  isRecord(value) &&
  optional(value.sheet, isId) &&
  isBox(value.values) &&
  optional(value.categories, isBox) &&
  optional(value.sizes, isBox) &&
  optional(value.name, isText) &&
  optional(value.kind, oneOf("column", "line", "area")) &&
  optional(value.axis, oneOf("left", "right")) &&
  optional(value.color, isColor) &&
  optional(
    value.line,
    (line) =>
      isRecord(line) &&
      ["smooth", "step", "markers", "dashed"].every((key) => optional(line[key], isBool)),
  ) &&
  optional(value.labels, isLabels) &&
  optional(value.trendline, isBool);
const isStyle = (value: unknown) =>
  isRecord(value) &&
  optional(value.palette, (palette) => typeof palette === "string" && palette.length <= 40) &&
  optional(
    value.hole,
    (hole) => isFinite(hole) && (hole as number) >= 0 && (hole as number) < 0.95,
  ) &&
  optional(value.gap, (gap) => isFinite(gap) && (gap as number) >= 0 && (gap as number) <= 0.9) &&
  optional(value.labels, isLabels);
const isSource = (value: unknown) =>
  isRecord(value) &&
  isId(value.sheet) &&
  isBox(value.box) &&
  isBool(value.headers) &&
  isBool(value.labels) &&
  isBool(value.byRow);
const isSize = (value: unknown) =>
  isRecord(value) &&
  isFinite(value.width) &&
  isFinite(value.height) &&
  (value.width as number) >= CHART_LIMITS.width.min &&
  (value.width as number) <= CHART_LIMITS.width.max &&
  (value.height as number) >= CHART_LIMITS.height.min &&
  (value.height as number) <= CHART_LIMITS.height.max;
const CHECKS: Record<string, (value: unknown) => boolean> = {
  sheet: isId,
  at: (value) => isRecord(value) && isId(value.r) && isId(value.c),
  size: isSize,
  kind: oneOf(...CHART_KINDS),
  stack: oneOf("none", "stacked", "percent"),
  title: isText,
  subtitle: isText,
  legend: oneOf("none", "top", "bottom", "left", "right"),
  axes: (value) =>
    isRecord(value) &&
    Object.entries(value).every(([key, axis]) => ["x", "y", "y2"].includes(key) && isAxis(axis)),
  series: (value) =>
    Array.isArray(value) && value.length <= CHART_LIMITS.series && value.every(isSeries),
  source: isSource,
  style: isStyle,
};

export const isChart = (value: unknown) =>
  isRecord(value) &&
  ["sheet", "at", "size", "kind", "series"].every((key) => value[key] !== undefined) &&
  Object.entries(value).every(([key, field]) => CHECKS[key]?.(field) ?? false);

/** A patch's keys each as a chart holds them, or null to remove one; axes and style one level down. */
export const isChartPatch = (value: unknown) =>
  isRecord(value) &&
  Object.entries(value).every(([key, field]) => {
    if (key === "axes")
      return (
        isRecord(field) &&
        Object.entries(field).every(
          ([axis, each]) => ["x", "y", "y2"].includes(axis) && (each === null || isAxis(each)),
        )
      );
    if (key === "style")
      return (
        isRecord(field) &&
        isStyle(Object.fromEntries(Object.entries(field).filter(([, each]) => each !== null)))
      );
    if (field === null) return !["sheet", "at", "size", "kind", "series"].includes(key);
    return CHECKS[key]?.(field) ?? false;
  });

/** A copy of `base` with each key of `changes` set, or removed where it is null. */
const merge = <T extends object>(base: T, changes: object): T => {
  const out: Partial<Record<keyof T, unknown>> = { ...base };
  for (const [key, value] of Object.entries(changes) as Array<[keyof T, unknown]>)
    if (value === null) delete out[key];
    else out[key] = value;
  // Every key was checked as the chart holds it.
  return out as T;
};

/** The chart with a patch applied: each key replaced or removed, axes and style merged a level down. */
export function patchChart(chart: Chart, patch: ChartPatch): Chart {
  const { axes, style, ...rest } = patch;
  let next = merge(chart, rest);
  if (axes) next = merge(next, { axes: merge(chart.axes ?? {}, axes) });
  if (style) next = merge(next, { style: merge(chart.style ?? {}, style) });
  return next;
}

// ---- reading cells

/** What a chart reads of a cell: its value and the text the sheet shows for it. */
function reader(doc: SheetDoc, values: SheetValues) {
  const locale = sheetLocale(doc.settings.locale);
  const formatOf = (sheet: string, r: string, c: string) => {
    const key = doc.sheet[sheet]?.cells[r]?.[c]?.s;
    const format = key ? (JSON.parse(key) as { numberFormat?: unknown }).numberFormat : undefined;
    return typeof format === "string" ? format : undefined;
  };
  const shown = (value: Scalar, format: string | undefined) => {
    if (value === null) return "";
    if (value instanceof XError) return value.code;
    if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
    const formatted = format ? formatValue(value, format, locale)?.text : undefined;
    if (formatted !== undefined) return formatted;
    return typeof value === "number" ? generalText(value, locale) : value;
  };
  /** A box's cells in reading order: down a column or along a row, as a series reads them. */
  const cells = (sheet: string, box: Box, limit: number = CHART_LIMITS.points) => {
    const data = doc.sheet[sheet];
    if (!data) return null;
    const rows = positions(data.rows);
    const cols = positions(data.cols);
    const [top, bottom, left, right] = [
      rows.at(box.r1),
      rows.at(box.r2),
      cols.at(box.c1),
      cols.at(box.c2),
    ];
    if (!top || !bottom || !left || !right) return null;
    const out: Array<{ value: Scalar; text: string; format: string | undefined }> = [];
    for (let row = Math.min(top, bottom); row <= Math.max(top, bottom); row++)
      for (let col = Math.min(left, right); col <= Math.max(left, right); col++) {
        const [r, c] = [rows.ids[row - 1]!, cols.ids[col - 1]!];
        const value = values.value(sheet, r, c);
        const format = formatOf(sheet, r, c);
        out.push({ value, text: shown(value, format), format });
        if (out.length >= limit) return out;
      }
    return out;
  };
  const text = (label: ChartText | undefined) => {
    if (!label) return undefined;
    if ("text" in label) return label.text;
    const value = values.value(label.cell.sh, label.cell.r, label.cell.c);
    return shown(value, formatOf(label.cell.sh, label.cell.r, label.cell.c));
  };
  return { cells, text, locale };
}

/** What a chart draws now, from the cells' calculated values. */
export interface ChartData {
  readonly title?: string;
  readonly subtitle?: string;
  /** One label per point, as the sheet shows it. */
  readonly categories: readonly string[];
  /** A scatter's or bubble's x values, when its categories are numbers. */
  readonly x: readonly (number | null)[] | null;
  readonly series: ReadonlyArray<{
    readonly name: string;
    readonly values: readonly (number | null)[];
    readonly sizes: readonly (number | null)[] | null;
    /** The values' own number format, for axes, labels and tooltips that follow the cells. */
    readonly format: string | undefined;
    /** Its ranges were deleted: drawn as nothing, named as broken. */
    readonly broken: boolean;
  }>;
  /** Text the sheet shows axis titles as. */
  readonly axisTitles: { readonly x?: string; readonly y?: string; readonly y2?: string };
}

const numbers = (cells: ReadonlyArray<{ value: Scalar }>) =>
  cells.map(({ value }) => (typeof value === "number" ? value : null));

export function chartData(doc: SheetDoc, values: SheetValues, chart: Chart): ChartData {
  const read = reader(doc, values);
  const limit = chart.kind === "histogram" ? CHART_LIMITS.histogramValues : CHART_LIMITS.points;
  const series = chart.series.map((each, index) => {
    const sheet = each.sheet ?? chart.sheet;
    const cells = read.cells(sheet, each.values, limit);
    const sizes = each.sizes ? read.cells(sheet, each.sizes, limit) : null;
    return {
      name: read.text(each.name) || `Series ${index + 1}`,
      values: cells ? numbers(cells) : [],
      sizes: sizes ? numbers(sizes) : null,
      format: cells?.find((cell) => typeof cell.value === "number")?.format,
      broken: cells === null,
    };
  });
  const first = chart.series[0];
  const labelCells = first?.categories
    ? read.cells(first.sheet ?? chart.sheet, first.categories, limit)
    : null;
  const length = Math.max(0, ...series.map((each) => each.values.length));
  const numeric =
    !!labelCells?.length && labelCells.every((cell) => typeof cell.value === "number");
  return {
    ...(chart.title ? { title: read.text(chart.title)! } : {}),
    ...(chart.subtitle ? { subtitle: read.text(chart.subtitle)! } : {}),
    // Points without a label are numbered, as Excel numbers them.
    categories: Array.from(
      { length },
      (_, index) => labelCells?.[index]?.text ?? String(index + 1),
    ),
    x: labelCells && numeric ? numbers(labelCells) : null,
    series,
    axisTitles: {
      ...(chart.axes?.x?.title ? { x: read.text(chart.axes.x.title)! } : {}),
      ...(chart.axes?.y?.title ? { y: read.text(chart.axes.y.title)! } : {}),
      ...(chart.axes?.y2?.title ? { y2: read.text(chart.axes.y2.title)! } : {}),
    },
  };
}

// ---- making series from a range, as Excel reads one

/** A range by IDs as row and column IDs in order; null when an end is gone. */
function span(doc: SheetDoc, sheet: string, box: Box) {
  const data = doc.sheet[sheet];
  if (!data) return null;
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [top, bottom, left, right] = [
    rows.at(box.r1),
    rows.at(box.r2),
    cols.at(box.c1),
    cols.at(box.c2),
  ];
  if (!top || !bottom || !left || !right) return null;
  return {
    rows: rows.ids.slice(Math.min(top, bottom) - 1, Math.max(top, bottom)),
    cols: cols.ids.slice(Math.min(left, right) - 1, Math.max(left, right)),
  };
}

const DATE_FORMAT = /[dmy]/i;
/** Text, or a date: a cell that labels a point rather than measures one. */
const isLabel = (value: Scalar, format: string | undefined) =>
  (typeof value === "string" && value !== "") ||
  (typeof value === "number" && !!format && DATE_FORMAT.test(format.replace(/"[^"]*"/g, "")));

/**
 * How Excel reads a range it charts: a top row whose cells label rather than
 * measure names the series, a first column of labels names the points, and
 * series run down columns unless the data is wider than it is tall.
 */
export function readSource(
  doc: SheetDoc,
  values: SheetValues,
  sheet: string,
  box: Box,
): ChartSource {
  const ids = span(doc, sheet, box);
  if (!ids) return { sheet, box, headers: false, labels: false, byRow: false };
  const formatOf = (r: string, c: string) => {
    const key = doc.sheet[sheet]?.cells[r]?.[c]?.s;
    const format = key ? (JSON.parse(key) as { numberFormat?: unknown }).numberFormat : undefined;
    return typeof format === "string" ? format : undefined;
  };
  const labelAt = (r: string, c: string) => isLabel(values.value(sheet, r, c), formatOf(r, c));
  const blank = (r: string, c: string) => values.value(sheet, r, c) === null;
  const [top, rest] = [ids.rows[0]!, ids.rows.slice(1)];
  const headers =
    ids.rows.length > 1 &&
    ids.cols.some((c) => labelAt(top, c)) &&
    ids.cols.every((c) => labelAt(top, c) || blank(top, c));
  const body = headers ? rest : ids.rows;
  const first = ids.cols[0]!;
  const labels =
    ids.cols.length > 1 &&
    body.length > 0 &&
    body.every((r) => labelAt(r, first) || blank(r, first)) &&
    body.some((r) => labelAt(r, first));
  const height = body.length;
  const width = ids.cols.length - (labels ? 1 : 0);
  return { sheet, box, headers, labels, byRow: width > height && !labels };
}

/**
 * The series a source gives a chart of this kind. With the sheet's values,
 * columns (or rows) holding no numbers are left out, so a table's text
 * columns do not become empty series.
 */
export function seriesFrom(
  doc: SheetDoc,
  source: ChartSource,
  kind: ChartKind,
  values?: SheetValues,
): ChartSeries[] {
  const ids = span(doc, source.sheet, source.box);
  if (!ids) return [];
  const [rows, cols] = source.byRow ? [ids.cols, ids.rows] : [ids.rows, ids.cols];
  // Read as columns: `rows` run along a series, `cols` are one series each.
  const along = source.headers ? rows.slice(1) : rows;
  const lines = source.labels ? cols.slice(1) : cols;
  const measured = (line: string) =>
    along.some((cell) => {
      const [r, c] = source.byRow ? [line, cell] : [cell, line];
      return typeof values!.value(source.sheet, r, c) === "number";
    });
  const numeric = values ? lines.filter(measured) : lines;
  const across = numeric.length ? numeric : lines;
  if (!along.length || !across.length) return [];
  const box = (line: string, from: string, to: string): Box =>
    source.byRow
      ? { r1: line, r2: line, c1: from, c2: to }
      : { r1: from, r2: to, c1: line, c2: line };
  const header = (line: string) =>
    source.headers
      ? {
          cell: source.byRow
            ? { sh: source.sheet, r: line, c: rows[0]! }
            : { sh: source.sheet, r: rows[0]!, c: line },
        }
      : undefined;
  const categories = source.labels ? box(cols[0]!, along[0]!, along.at(-1)!) : undefined;
  const range = (line: string) => box(line, along[0]!, along.at(-1)!);
  const named = (line: string, rest: Omit<ChartSeries, "name">): ChartSeries => {
    const name = header(line);
    return name ? { ...rest, name } : rest;
  };
  // A scatter's first measured column is its x, unless labels already are; a bubble's third its sizes.
  if (kind === "scatter" || kind === "bubble") {
    const [x, ...ys] = source.labels ? [cols[0]!, ...across] : across;
    if (!ys.length) return [named(x!, { values: range(x!) })];
    if (kind === "bubble") {
      const [y, size] = ys;
      return [
        named(y!, {
          values: range(y!),
          categories: range(x!),
          ...(size ? { sizes: range(size) } : {}),
        }),
      ];
    }
    return ys.map((y) => named(y, { values: range(y), categories: range(x!) }));
  }
  const all = across.map((line) =>
    named(line, { values: range(line), ...(categories ? { categories } : {}) }),
  );
  // A pie, a doughnut, a waterfall and a histogram draw one series.
  return ["pie", "doughnut", "waterfall", "histogram"].includes(kind)
    ? all.slice(0, 1)
    : all.slice(0, CHART_LIMITS.series);
}

/** Options a person set on a series, kept by position when its ranges are read again. */
const OWN_KEYS = ["kind", "axis", "color", "line", "labels", "trendline"] as const;
export function rebuildSeries(
  doc: SheetDoc,
  chart: Chart,
  source: ChartSource,
  values?: SheetValues,
): Chart {
  const fresh = seriesFrom(doc, source, chart.kind, values);
  const series = fresh.map((each, index) => {
    const old = chart.series[index];
    if (!old) return each;
    const own = Object.fromEntries(
      OWN_KEYS.flatMap((key) => (old[key] === undefined ? [] : [[key, old[key]]])),
    );
    // A name typed in stays; one read from a header follows the new range.
    const name = old.name && "text" in old.name ? { name: old.name } : {};
    return { ...each, ...own, ...name };
  });
  return { ...chart, source, series };
}

/**
 * Chart kinds that suit a range, best first, as a person would choose them:
 * dates or many points read as a line, a few positive parts as a pie, two
 * measured columns as a scatter, one as a histogram, the rest as columns.
 */
export function suggestKinds(doc: SheetDoc, values: SheetValues, source: ChartSource): ChartKind[] {
  const read = reader(doc, values);
  const series = seriesFrom(doc, source, "column", values);
  if (!series.length) return ["column", "bar", "line"];
  const first = series[0]!;
  const sheet = first.sheet ?? source.sheet;
  const points = read.cells(sheet, first.values) ?? [];
  const labels = first.categories ? (read.cells(sheet, first.categories) ?? []) : [];
  const dated = labels.some(
    (cell) => typeof cell.value === "number" && cell.format && DATE_FORMAT.test(cell.format),
  );
  const positive = points.every((cell) => typeof cell.value !== "number" || cell.value >= 0);
  const signed = points.some((cell) => typeof cell.value === "number" && cell.value < 0);
  const order: ChartKind[] = [];
  if (!source.labels && series.length === 2 && !source.headers) order.push("scatter");
  if (!source.labels && series.length === 1 && points.length > 12) order.push("histogram");
  if (dated || points.length > 20) order.push("line", "area");
  if (series.length === 1 && positive && points.length >= 2 && points.length <= 8 && source.labels)
    order.push("pie", "doughnut");
  if (series.length === 1 && signed) order.push("waterfall");
  order.push("column", "bar", "line", "area", "scatter");
  return [...new Set(order)];
}
