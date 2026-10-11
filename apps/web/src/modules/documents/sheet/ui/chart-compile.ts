import { areaY, barX, barY, defineChart, dot, lineY } from "@tanstack/charts";
import { d3Curve } from "@tanstack/charts/d3/shape";
import { group } from "@tanstack/charts/group";
import { pie, polar, radialArc, radialText } from "@tanstack/charts/polar";
import { linearRegressionY } from "@tanstack/charts/regression";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { text } from "@tanstack/charts/text";
import { tooltip } from "@tanstack/charts/tooltip";
import { binX } from "@tanstack/charts/transform/bin";
import { waterfall } from "@tanstack/charts/transform/waterfall";
import { rect, type ChartMark, type ChartValue } from "@tanstack/charts";
import { curveMonotoneX, curveStepAfter } from "d3-shape";
import { scaleLog, scaleSqrt } from "d3-scale";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Chart, ChartAxis, ChartData, ChartSeries } from "@chat/sheet/model/chart";
import { formatValue, generalText } from "@chat/sheet/number-format";

/** The palette series take in turn: theme tokens, so charts follow light and dark. */
export const CHART_PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];
/** A series' colour: its own, else the palette's at its place. */
export const seriesColor = (series: ChartSeries | undefined, index: number) =>
  series?.color ?? CHART_PALETTE[index % CHART_PALETTE.length]!;

/** One point as the chart library reads it. */
interface Row {
  readonly x: string;
  /** A scatter's numeric x, or the point's place. */
  readonly n: number;
  readonly series: string;
  readonly index: number;
  readonly value: number | null;
  readonly size: number | null;
}

/** Numbers as the cells show them, or as an axis or label's own format says. */
export const formatter =
  (locale: SheetLocale, code: string | undefined) =>
  (value: unknown): string => {
    if (typeof value !== "number") return String(value ?? "");
    const formatted = code ? formatValue(value, code, locale)?.text : undefined;
    return formatted ?? generalText(value, locale);
  };

/** An axis's scale config: fixed ends, log, reversed, gridlines, its title and format. */
function valueAxis(
  axis: ChartAxis | undefined,
  extent: readonly [number, number],
  format: (value: unknown) => string,
  includeZero: boolean,
  label?: string,
) {
  const low = includeZero ? Math.min(0, extent[0]) : extent[0];
  const high = includeZero ? Math.max(0, extent[1]) : extent[1];
  const fixed = axis?.min !== undefined || axis?.max !== undefined;
  const domain: [number, number] = [axis?.min ?? low, axis?.max ?? high];
  const scale = axis?.log
    ? scaleLog().domain([Math.max(domain[0], 1e-9), Math.max(domain[1], 1e-9)])
    : fixed
      ? scaleLinear().domain(domain)
      : scaleLinear;
  return {
    scale,
    nice: !fixed && !axis?.log,
    grid: axis?.gridlines ?? true,
    ...(axis?.reverse ? { reverse: true } : {}),
    axis: axis?.hidden
      ? (false as const)
      : {
          line: false,
          ticks: { format },
          ...(label ? { label } : {}),
        },
  };
}
const categoryAxis = (axis: ChartAxis | undefined, gap: number, label?: string) => ({
  scale: () => scaleBand<string>().padding(gap),
  ...(axis?.reverse ? { reverse: true } : {}),
  axis: axis?.hidden
    ? (false as const)
    : {
        line: false,
        tickLabels: { thin: { minGap: 8, priority: "ends" as const } },
        ...(label ? { label } : {}),
      },
});
const extentOf = (values: readonly (number | null)[]): [number, number] => {
  const numbers = values.filter((value): value is number => value !== null);
  return numbers.length ? [Math.min(...numbers), Math.max(...numbers)] : [0, 1];
};

export interface CompileInput {
  readonly chart: Chart;
  readonly data: ChartData;
  readonly locale: SheetLocale;
  /** Series hidden from the legend while viewing, by index. */
  readonly hidden?: ReadonlySet<number>;
}

/**
 * A chart's definition for the chart library: the series it shows as marks,
 * its axes from the chart's options, numbers formatted as the cells are.
 * Titles and the legend are drawn around it, not in it.
 */
export function compileChart({ chart, data, locale, hidden = new Set() }: CompileInput) {
  const shown = data.series.flatMap((series, index) =>
    hidden.has(index) || series.broken ? [] : [{ series, spec: chart.series[index], index }],
  );
  const firstFormat = shown.find((each) => each.series.format)?.series.format;
  const yFormat = formatter(locale, chart.axes?.y?.format ?? firstFormat);
  const y2Format = formatter(
    locale,
    chart.axes?.y2?.format ??
      shown.find((each) => each.spec?.axis === "right")?.series.format ??
      firstFormat,
  );
  const color = {
    domain: shown.map((each) => each.series.name),
    range: shown.map((each) => seriesColor(each.spec, each.index)),
  };
  const rowsOf = (each: (typeof shown)[number]): Row[] =>
    data.categories.map((x, at) => ({
      x,
      n: data.x?.[at] ?? at + 1,
      series: each.series.name,
      index: each.index,
      value: each.series.values[at] ?? null,
      size: each.series.sizes?.[at] ?? null,
    }));
  const formatOf = (index: number) =>
    formatter(locale, chart.series[index]?.labels?.format ?? data.series[index]?.format);
  const tooltipOf = {
    use: tooltip,
    format: (point: { datum: unknown }) => {
      const datum = point.datum as Partial<Row> & { delta?: number };
      const value = datum.value ?? datum.delta ?? null;
      return `${datum.x ?? ""}${datum.series ? ` · ${datum.series}` : ""}: ${formatOf(datum.index ?? 0)(value)}`;
    },
  };
  const gap = chart.style?.gap ?? 0.25;
  const titles = data.axisTitles;
  const allValues = shown.flatMap((each) => each.series.values);

  // ---- pie and doughnut: the first series, its points as slices
  if (chart.kind === "pie" || chart.kind === "doughnut") {
    const first = shown[0];
    const rows = (first ? rowsOf(first) : []).map((row, at) => ({
      ...row,
      key: `${at}:${row.x}`,
      value: Math.max(0, row.value ?? 0),
    }));
    const hole = chart.kind === "doughnut" ? (chart.style?.hole ?? 0.55) : (chart.style?.hole ?? 0);
    const slices = pie(rows, { value: "value" });
    const labels = chart.style?.labels ?? first?.spec?.labels;
    const format = formatOf(first?.index ?? 0);
    const arcs = radialArc(slices, {
      color: "key",
      key: "key",
      ...(hole ? { innerRadius: ({ radius }: { radius: number }) => radius * hole } : {}),
    });
    const ring = { inset: 4, radiusRatio: 0.9 };
    return defineChart({
      marks: [
        labels?.show
          ? polar({
              ...ring,
              marks: [
                arcs,
                // Midway across the ring, at each slice's middle angle; slivers go unlabelled.
                radialText(
                  slices.filter((slice) => slice.fraction >= 0.03),
                  {
                    angle: "angle",
                    radius: () => (1 + hole) / 2,
                    key: "key",
                    text: (slice) =>
                      labels.content === "category"
                        ? slice.x
                        : labels.content === "value"
                          ? format(slice.value)
                          : `${Math.round(slice.fraction * 100)}%`,
                    fill: "white",
                    fontSize: 11,
                    fontWeight: 600,
                  },
                ),
              ],
              // In radians and as a share of the radius, as the labels place themselves.
              scales: {
                angle: { scale: scaleLinear().domain([0, 2 * Math.PI]) },
                radius: { scale: scaleLinear().domain([0, 1]) },
              },
            })
          : polar({ ...ring, marks: [arcs], scales: { angle: null, radius: null } }),
      ],
      scales: { x: null, y: null },
      color: {
        domain: rows.map((row) => row.key),
        range: rows.map((_, at) => CHART_PALETTE[at % CHART_PALETTE.length]!),
      },
      tooltip: {
        use: tooltip,
        format: (point: { datum: unknown }) => {
          const datum = point.datum as { x: string; value: number; fraction?: number };
          const share =
            datum.fraction === undefined ? "" : ` (${Math.round(datum.fraction * 100)}%)`;
          return `${datum.x}: ${formatOf(first?.index ?? 0)(datum.value)}${share}`;
        },
      },
    });
  }

  // ---- histogram: the first series' values, counted into bins
  if (chart.kind === "histogram") {
    const values = (shown[0]?.series.values ?? []).flatMap((value) =>
      value === null ? [] : [{ value }],
    );
    const bins = binX(values, { value: "value", outputs: { count: { reduce: "count" } } });
    return defineChart({
      marks: [
        rect(bins, {
          x1: "x1",
          x2: "x2",
          y: "count",
          fill: seriesColor(shown[0]?.spec, 0),
          inset: 0.5,
        }),
      ],
      scales: {
        x: valueAxis(chart.axes?.x, extentOf(values.map((each) => each.value)), yFormat, false),
        y: valueAxis(
          chart.axes?.y,
          [0, Math.max(1, ...bins.map((bin) => bin.count))],
          formatter(locale, "0"),
          true,
        ),
      },
      tooltip,
    });
  }

  // ---- waterfall: the first series' changes as running intervals
  if (chart.kind === "waterfall") {
    const first = shown[0];
    const steps = waterfall<Row & { value: number }>(
      first ? rowsOf(first).map((row) => ({ ...row, value: row.value ?? 0 })) : [],
      {
        value: "value",
      },
    );
    const ends = steps.flatMap((step) => [step.start, step.end]);
    return defineChart({
      marks: [
        barY(steps, {
          x: (step) => ("x" in step ? String(step.x) : "Total"),
          y1: "start",
          y2: "end",
          color: "kind",
          radius: 2,
        }),
      ],
      scales: {
        x: categoryAxis(chart.axes?.x, gap),
        y: valueAxis(chart.axes?.y, extentOf(ends), yFormat, true),
      },
      color: {
        domain: ["increase", "decrease", "total"],
        range: ["var(--chart-3)", "var(--destructive)", "var(--chart-1)"],
      },
      tooltip: tooltipOf,
    });
  }

  // ---- scatter and bubble: numeric x when the categories are numbers
  if (chart.kind === "scatter" || chart.kind === "bubble") {
    const rows = shown.flatMap(rowsOf).filter((row) => row.value !== null);
    const bubble = chart.kind === "bubble";
    const marks = [
      dot(rows, {
        x: "n",
        y: "value",
        color: "series",
        ...(bubble ? { r: "size", rScale: scaleSqrt().range([3, 24]) } : {}),
      }),
      ...shown.flatMap((each) =>
        each.spec?.trendline
          ? [
              linearRegressionY(
                rowsOf(each).filter((row) => row.value !== null),
                {
                  x: "n",
                  y: "value",
                  ci: 0,
                  stroke: seriesColor(each.spec, each.index),
                },
              ),
            ]
          : [],
      ),
      ...labelMarks(shown, rowsOf, chart, formatOf, "n"),
    ];
    return defineChart({
      marks,
      scales: {
        x: valueAxis(
          chart.axes?.x,
          extentOf(rows.map((row) => row.n)),
          formatter(locale, chart.axes?.x?.format),
          false,
        ),
        y: valueAxis(chart.axes?.y, extentOf(rows.map((row) => row.value)), yFormat, false),
      },
      color,
      tooltip: tooltipOf,
    });
  }

  // ---- column, bar, line and area, with per-series types for a combo
  const kindOf = (each: (typeof shown)[number]) =>
    chart.kind === "bar" ? "bar" : (each.spec?.kind ?? (chart.kind as "column" | "line" | "area"));
  const right = shown.filter((each) => each.spec?.axis === "right" && chart.kind !== "bar");
  const left = shown.filter((each) => !right.includes(each));
  const stacking = chart.stack ?? "none";
  const layout = (count: number) =>
    stacking === "percent"
      ? { layout: stack({ offset: "normalize" }) }
      : stacking === "stacked"
        ? { layout: stack() }
        : count > 1
          ? { layout: group() }
          : {};
  /** Any Cartesian mark, on either value scale. */
  const marks: ChartMark<
    unknown,
    ChartValue,
    ChartValue,
    ChartValue,
    ChartValue,
    string,
    string
  >[] = [];
  for (const side of [left, right]) {
    const yScale = side === right ? { yScale: "y2" } : {};
    const bars = side.filter((each) => kindOf(each) === "column" || kindOf(each) === "bar");
    const areas = side.filter((each) => kindOf(each) === "area");
    if (bars.length) {
      const rows = bars.flatMap(rowsOf);
      marks.push(
        chart.kind === "bar"
          ? barX(rows, {
              x: "value",
              y: "x",
              z: "series",
              color: "series",
              radius: 2,
              ...layout(bars.length),
            })
          : barY(rows, {
              x: "x",
              y: "value",
              z: "series",
              color: "series",
              radius: 2,
              inset: 1,
              ...layout(bars.length),
              ...yScale,
            }),
      );
    }
    if (areas.length) {
      const rows = areas.flatMap(rowsOf);
      const options = {
        x: "x",
        y: "value",
        z: "series",
        color: "series",
      } as const;
      // Areas stack or overlap; side by side means nothing for an area.
      const areaLayout =
        stacking === "percent"
          ? { layout: stack({ offset: "normalize" }) }
          : stacking === "stacked"
            ? { layout: stack() }
            : {};
      marks.push(
        side === right
          ? areaY(rows, { ...options, ...areaLayout, yScale: "y2" })
          : areaY(rows, { ...options, ...areaLayout }),
      );
    }
    for (const each of side.filter((one) => kindOf(one) === "line" || kindOf(one) === "area")) {
      const line = each.spec?.line;
      // An area's top edge is drawn as its line; stacked areas keep only their fill.
      if (kindOf(each) === "area" && stacking !== "none") continue;
      marks.push(
        lineY(rowsOf(each), {
          x: "x",
          y: "value",
          color: "series",
          strokeWidth: 2,
          ...(line?.smooth ? { curve: d3Curve(curveMonotoneX) } : {}),
          ...(line?.step ? { curve: d3Curve(curveStepAfter) } : {}),
          ...(line?.markers ? { points: true } : {}),
          ...(line?.dashed ? { strokeDasharray: "5 4" } : {}),
          ...yScale,
        }),
      );
    }
  }
  // Labels go on lines and single unstacked bar series, where they cannot overlap a neighbour.
  const labelled = shown.filter(
    (each) =>
      kindOf(each) === "line" ||
      (stacking === "none" && shown.filter((one) => kindOf(one) !== "line").length === 1),
  );
  if (chart.kind !== "bar") marks.push(...labelMarks(labelled, rowsOf, chart, formatOf, "x"));
  const percent = stacking === "percent";
  const leftValues = left.flatMap((each) => each.series.values);
  const stackedExtent = (): [number, number] => {
    const sums = data.categories.map((_, at) =>
      left.reduce((sum, each) => sum + Math.max(0, each.series.values[at] ?? 0), 0),
    );
    const lows = data.categories.map((_, at) =>
      left.reduce((sum, each) => sum + Math.min(0, each.series.values[at] ?? 0), 0),
    );
    return [Math.min(0, ...lows), Math.max(0, ...sums)];
  };
  const leftExtent: [number, number] = percent
    ? [0, 1]
    : stacking === "stacked"
      ? stackedExtent()
      : extentOf(leftValues.length ? leftValues : allValues);
  const valueScale = valueAxis(
    chart.axes?.y,
    leftExtent,
    percent ? formatter(locale, "0%") : yFormat,
    true,
    titles.y,
  );
  const categoryScale = categoryAxis(chart.axes?.x, gap, titles.x);
  return defineChart({
    // The library takes any of its marks here; each was built with its own options above.
    marks,
    scales:
      chart.kind === "bar"
        ? { x: valueScale, y: categoryScale }
        : {
            x: categoryScale,
            y: valueScale,
            ...(right.length
              ? {
                  y2: {
                    channel: "y" as const,
                    side: "right" as const,
                    ...valueAxis(
                      chart.axes?.y2,
                      extentOf(right.flatMap((each) => each.series.values)),
                      y2Format,
                      true,
                      titles.y2,
                    ),
                  },
                }
              : {}),
          },
    color,
    tooltip: tooltipOf,
  });
}

/** Value labels above each point of the series that show them. */
function labelMarks(
  shown: ReadonlyArray<{ spec: ChartSeries | undefined; index: number }>,
  rowsOf: (each: never) => Row[],
  chart: Chart,
  formatOf: (index: number) => (value: unknown) => string,
  x: "x" | "n",
) {
  return shown.flatMap((each) => {
    const labels = each.spec?.labels ?? chart.style?.labels;
    if (!labels?.show) return [];
    const format = formatOf(each.index);
    const rows = (rowsOf as (one: typeof each) => Row[])(each).filter((row) => row.value !== null);
    return [
      text(rows, {
        x,
        y: "value",
        text: (row: Row) => (labels.content === "category" ? row.x : format(row.value)),
        dy: -8,
        fill: "currentColor",
        ...(each.spec?.axis === "right" ? { yScale: "y2" } : {}),
      }),
    ];
  });
}
