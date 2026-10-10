import { parseRange } from "@chat/sheet/a1";
import { quoteSheet } from "@chat/sheet/model/formula";
import { liveSheets, positions, type Box, type SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { Chart, ChartAxis, ChartSeries, ChartText } from "@chat/sheet/model/chart";
import { XError } from "@chat/sheet/engine/evaluate";
import type { FileAxis, FileChart, FileSeries } from "~/modules/spreadsheets/server/file-charts.ts";
import { columnLetters } from "@chat/sheet/a1";

const address = (row: number, column: number) => `${columnLetters(column)}${row}`;

/**
 * A chart's text as the file keeps it: as written, or what its cell shows
 * now, a formula's result included when the values are known.
 */
export const textOf = (doc: SheetDoc, label: ChartText | undefined, values?: SheetValues) => {
  if (!label) return undefined;
  if ("text" in label) return label.text;
  const { sh, r, c } = label.cell;
  const value = values ? values.value(sh, r, c) : doc.sheet[sh]?.cells[r]?.[c]?.v;
  if (value instanceof XError) return value.code;
  return value === undefined || value === null ? undefined : String(value);
};

/** A range by IDs as A1 text naming its sheet; null once its rows or columns are gone. */
function rangeOf(doc: SheetDoc, on: string, box: Box) {
  const data = doc.sheet[on];
  if (!data || !liveSheets(doc).includes(on)) return null;
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const corners = [rows.at(box.r1), cols.at(box.c1), rows.at(box.r2), cols.at(box.c2)];
  if (corners.some((each) => each === undefined)) return null;
  const [top, left, bottom, right] = corners as [number, number, number, number];
  return `${quoteSheet(data.name)}!${address(top, left)}:${address(bottom, right)}`;
}

/**
 * A live chart as a file keeps it. What Excel's chart parts cannot hold here
 * is left out: a subtitle, the right axis and series drawn as another kind,
 * which Excel would need a second chart group for.
 */
export function fileChartOf(doc: SheetDoc, chart: Chart, values?: SheetValues): FileChart | null {
  const host = doc.sheet[chart.sheet];
  if (!host || !liveSheets(doc).includes(chart.sheet)) return null;
  const row = positions(host.rows).at(chart.at.r);
  const col = positions(host.cols).at(chart.at.c);
  const series = chart.series.flatMap((each): FileSeries[] => {
    const on = each.sheet ?? chart.sheet;
    const range = rangeOf(doc, on, each.values);
    if (!range) return [];
    const categories = each.categories ? rangeOf(doc, on, each.categories) : null;
    const sizes = each.sizes ? rangeOf(doc, on, each.sizes) : null;
    const name =
      each.name && "cell" in each.name
        ? rangeOf(doc, each.name.cell.sh, {
            r1: each.name.cell.r,
            r2: each.name.cell.r,
            c1: each.name.cell.c,
            c2: each.name.cell.c,
          })
        : null;
    const text = textOf(doc, each.name, values);
    return [
      {
        values: range,
        ...(categories ? { categories } : {}),
        ...(sizes ? { sizes } : {}),
        ...(name ? { name: { ref: name } } : text ? { name: { text } } : {}),
        ...(each.color ? { color: each.color } : {}),
        ...(each.labels?.show ? { labels: true } : {}),
        ...(each.line?.smooth ? { smooth: true } : {}),
        ...(each.line?.markers ? { markers: true } : {}),
        ...(each.line?.dashed ? { dashed: true } : {}),
        ...(each.trendline ? { trendline: true } : {}),
      },
    ];
  });
  if (!series.length || row === undefined || col === undefined) return null;
  const axis = (given: ChartAxis | undefined): FileAxis | undefined => {
    if (!given) return undefined;
    const title = textOf(doc, given.title, values);
    const { title: _title, ...rest } = given;
    return { ...rest, ...(title ? { title } : {}) };
  };
  const [x, y] = [axis(chart.axes?.x), axis(chart.axes?.y)];
  const title = textOf(doc, chart.title, values);
  return {
    sheet: host.name,
    at: address(row, col),
    ...(chart.offset ? { offset: chart.offset } : {}),
    width: chart.size.width,
    height: chart.size.height,
    kind: chart.kind,
    ...(chart.stack && chart.stack !== "none" ? { stack: chart.stack } : {}),
    ...(title ? { title } : {}),
    ...(chart.legend && chart.legend !== "none" ? { legend: chart.legend } : {}),
    ...(x || y ? { axes: { ...(x ? { x } : {}), ...(y ? { y } : {}) } } : {}),
    ...(chart.style?.hole !== undefined ? { hole: chart.style.hole } : {}),
    ...(chart.style?.gap !== undefined ? { gap: chart.style.gap } : {}),
    ...(chart.style?.labels?.show ? { labels: true } : {}),
    series,
  };
}

const axisOfFile = (given: FileAxis | undefined): ChartAxis | undefined => {
  if (!given) return undefined;
  const { title, ...rest } = given;
  return { ...rest, ...(title ? { title: { text: title.slice(0, 200) } } : {}) };
};

/**
 * A chart Excel wrote, as a live chart on the imported sheets; null when it
 * reads cells beyond them or on a sheet the file does not have.
 */
export function chartOfFile(doc: SheetDoc, file: FileChart): Chart | null {
  const byName = new Map(liveSheets(doc).map((id) => [doc.sheet[id]!.name.toLowerCase(), id]));
  const host = byName.get(file.sheet.toLowerCase());
  if (!host) return null;
  const read = (text: string): { sheet: string; box: Box } | null => {
    const bang = text.lastIndexOf("!");
    const name =
      bang === -1
        ? null
        : text
            .slice(0, bang)
            .replace(/^'(.*)'$/, "$1")
            .replaceAll("''", "'");
    const sheet = name === null ? host : byName.get(name.toLowerCase());
    const box = parseRange((bang === -1 ? text : text.slice(bang + 1)).replaceAll("$", ""));
    if (!sheet || !box) return null;
    const rows = positions(doc.sheet[sheet]!.rows).ids;
    const cols = positions(doc.sheet[sheet]!.cols).ids;
    const [r1, r2, c1, c2] = [
      rows[box.top - 1],
      rows[box.bottom - 1],
      cols[box.left - 1],
      cols[box.right - 1],
    ];
    return r1 && r2 && c1 && c2 ? { sheet, box: { r1, r2, c1, c2 } } : null;
  };
  const at = read(file.at);
  if (!at) return null;
  const series = file.series.flatMap((each): ChartSeries[] => {
    const values = read(each.values);
    if (!values) return [];
    const categories = each.categories ? read(each.categories) : null;
    const sizes = each.sizes ? read(each.sizes) : null;
    const nameCell = each.name && "ref" in each.name ? read(each.name.ref) : null;
    const name: ChartText | null = nameCell
      ? { cell: { sh: nameCell.sheet, r: nameCell.box.r1, c: nameCell.box.c1 } }
      : each.name && "text" in each.name
        ? { text: each.name.text.slice(0, 200) }
        : null;
    return [
      {
        values: values.box,
        ...(values.sheet === host ? {} : { sheet: values.sheet }),
        ...(categories?.sheet === values.sheet ? { categories: categories.box } : {}),
        ...(sizes?.sheet === values.sheet ? { sizes: sizes.box } : {}),
        ...(name ? { name } : {}),
        ...(each.color ? { color: each.color } : {}),
        ...(each.labels ? { labels: { show: true } } : {}),
        ...(each.smooth || each.markers || each.dashed
          ? {
              line: {
                ...(each.smooth ? { smooth: true } : {}),
                ...(each.markers ? { markers: true } : {}),
                ...(each.dashed ? { dashed: true } : {}),
              },
            }
          : {}),
        ...(each.trendline ? { trendline: true } : {}),
      },
    ];
  });
  if (!series.length) return null;
  const [x, y] = [axisOfFile(file.axes?.x), axisOfFile(file.axes?.y)];
  // A pie's labels are its slices', as the chart's own option, read as percents.
  const round = file.kind === "pie" || file.kind === "doughnut";
  const labels = file.labels || (round && series.some((each) => each.labels?.show));
  if (round)
    for (const [index, each] of series.entries()) {
      const { labels: _own, ...rest } = each;
      series[index] = rest;
    }
  return {
    sheet: host,
    at: { r: at.box.r1, c: at.box.c1 },
    ...(file.offset ? { offset: file.offset } : {}),
    size: { width: file.width, height: file.height },
    kind: file.kind,
    ...(file.stack ? { stack: file.stack } : {}),
    ...(file.title ? { title: { text: file.title.slice(0, 200) } } : {}),
    ...(file.legend ? { legend: file.legend } : {}),
    ...(x || y ? { axes: { ...(x ? { x } : {}), ...(y ? { y } : {}) } } : {}),
    ...(file.hole !== undefined || file.gap !== undefined || labels
      ? {
          style: {
            ...(file.hole !== undefined ? { hole: file.hole } : {}),
            ...(file.gap !== undefined ? { gap: file.gap } : {}),
            ...(labels
              ? { labels: { show: true, ...(round ? { content: "percent" as const } : {}) } }
              : {}),
          },
        }
      : {}),
    series: series.slice(0, 12),
  };
}
