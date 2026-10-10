import { XError } from "@chat/sheet/engine/values";
import type { SheetValues } from "@chat/sheet/model/calc";
import { positions, type Box, type Chart, type SheetDoc } from "@chat/sheet/model";

/** A chart's numbers as it draws them: one label per point, one list of values per series. */
export interface ChartData {
  readonly categories: readonly string[];
  readonly series: ReadonlyArray<{
    readonly name: string;
    readonly values: readonly (number | null)[];
  }>;
}

/** Points shown at most per series; a sheet's range can be far longer than a chart can show. */
const MAX_POINTS = 500;

/** A range's values in reading order, as a series reads them: down a column or along a row. */
function cellsOf(doc: SheetDoc, values: SheetValues, sheet: string, box: Box) {
  const data = doc.sheet[sheet];
  if (!data) return [];
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [top, bottom, left, right] = [
    rows.at(box.r1),
    rows.at(box.r2),
    cols.at(box.c1),
    cols.at(box.c2),
  ];
  if (!top || !bottom || !left || !right) return [];
  const out = [];
  for (let row = Math.min(top, bottom); row <= Math.max(top, bottom); row++)
    for (let col = Math.min(left, right); col <= Math.max(left, right); col++) {
      out.push(values.value(sheet, rows.ids[row - 1]!, cols.ids[col - 1]!));
      if (out.length >= MAX_POINTS) return out;
    }
  return out;
}

/** What a chart draws now, from the sheet's calculated values. */
export function chartData(doc: SheetDoc, values: SheetValues, chart: Chart): ChartData {
  const series = chart.series.map((each, index) => ({
    name: each.name ?? `Series ${index + 1}`,
    values: cellsOf(doc, values, each.sheet ?? chart.sheet, each.values).map((value) =>
      typeof value === "number" ? value : null,
    ),
  }));
  const first = chart.series[0];
  const labels = first?.categories
    ? cellsOf(doc, values, first.sheet ?? chart.sheet, first.categories).map((value) =>
        value === null ? "" : value instanceof XError ? value.code : String(value),
      )
    : [];
  const length = Math.max(0, ...series.map((each) => each.values.length));
  return {
    // Points without a label are numbered, as Excel numbers them.
    categories: Array.from({ length }, (_, index) => labels[index] ?? String(index + 1)),
    series,
  };
}
