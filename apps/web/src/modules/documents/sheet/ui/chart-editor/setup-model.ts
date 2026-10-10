import type { Box, SheetDoc } from "@chat/sheet/model";
import type { SheetValues } from "@chat/sheet/model/calc";
import type { Chart, ChartPatch, ChartSeries } from "@chat/sheet/model/chart";

/** What every part of the chart editor reads, and its one way to change the chart. */
export interface EditorContext {
  readonly doc: SheetDoc;
  readonly values: SheetValues;
  readonly chart: Chart;
  readonly readOnly: boolean;
  /** The grid's selection, for "use selection". */
  readonly selection: { readonly sheet: string; readonly box: Box };
  readonly patch: (patch: ChartPatch) => void;
}

/** A series with one option set, or removed when null. */
export function without<K extends Exclude<keyof ChartSeries, "values">>(
  series: ChartSeries,
  key: K,
  value: ChartSeries[K] | null,
): ChartSeries {
  const next: { -readonly [P in keyof ChartSeries]?: ChartSeries[P] } = { ...series };
  if (value === null) delete next[key];
  else next[key] = value;
  return { ...next, values: series.values };
}
