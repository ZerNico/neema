import {
  makeAreaChart,
  makeBarChart,
  makeBubbleChart,
  makeChartSpace,
  makeDoughnutChart,
  makeHistogramChart,
  makeLineChart,
  makePieChart,
  makeScatterChart,
  makeWaterfallChart,
  type BarSeries,
  type CategoryAxis,
  type ChartKind as FileKind,
  type ChartSpace,
  type DataLabelList,
  type LegendPosition,
  type LineSeries,
  type ValueAxis,
} from "@office-kit/xlsx/chart";
import {
  makeColor,
  makeNoFill,
  makeSolidFill,
  makeSrgbColor,
  type ChartReference,
  type ShapeProperties,
} from "@office-kit/xlsx/drawing";

/**
 * A chart the Excel tools add: ranges as A1 text naming their sheet, placed
 * by cell and pixels, mapped once to Excel's chart parts.
 */
export interface FileChart {
  readonly sheet: string;
  readonly at: string;
  /** Where its corner sits inside that cell, in pixels. */
  readonly offset?: { readonly x: number; readonly y: number };
  readonly width: number;
  readonly height: number;
  readonly kind:
    | "column"
    | "bar"
    | "line"
    | "area"
    | "pie"
    | "doughnut"
    | "scatter"
    | "bubble"
    | "waterfall"
    | "histogram";
  readonly stack?: "stacked" | "percent";
  readonly title?: string;
  readonly legend?: "top" | "bottom" | "left" | "right";
  /** The horizontal and vertical axes, whichever of them measures. */
  readonly axes?: { readonly x?: FileAxis; readonly y?: FileAxis };
  readonly series: readonly FileSeries[];
  /** A doughnut's hole, as a share of its radius. */
  readonly hole?: number;
  /** Space between bar groups, as a share of a band. */
  readonly gap?: number;
  /** Data labels on every series: values, or percents on a pie. */
  readonly labels?: boolean;
}
export interface FileAxis {
  readonly title?: string;
  readonly min?: number;
  readonly max?: number;
  readonly log?: boolean;
  readonly format?: string;
  readonly gridlines?: boolean;
  readonly reverse?: boolean;
  readonly hidden?: boolean;
}
export interface FileSeries {
  readonly values: string;
  readonly categories?: string;
  readonly sizes?: string;
  /** Literal text, or the cell Excel reads the name from. */
  readonly name?: { readonly text: string } | { readonly ref: string };
  readonly color?: string;
  readonly labels?: boolean;
  readonly smooth?: boolean;
  readonly markers?: boolean;
  readonly dashed?: boolean;
  readonly trendline?: boolean;
}

const LEGEND: Record<NonNullable<FileChart["legend"]>, LegendPosition> = {
  top: "t",
  bottom: "b",
  left: "l",
  right: "r",
};

const solid = (hex: string) => makeSolidFill(makeColor(makeSrgbColor(hex.replace(/^#/, ""))));
/** A series' fill and line as Excel draws them: its own colour, a dashed or hidden line. */
function shapeOf(series: FileSeries, line: boolean, hideLine = false): ShapeProperties | undefined {
  const fill = series.color ? solid(series.color) : undefined;
  if (!line) return fill ? { fill } : undefined;
  if (hideLine) return { ln: { fill: makeNoFill() } };
  if (!fill && !series.dashed) return undefined;
  return {
    ln: {
      w: 28_575,
      ...(fill ? { fill } : {}),
      ...(series.dashed ? { dash: { kind: "preset", val: "dash" } } : {}),
    },
  };
}
const labelsOf = (on: boolean, percent: boolean): DataLabelList | undefined =>
  on
    ? {
        showLegendKey: false,
        showVal: !percent,
        showCatName: false,
        showSerName: false,
        showPercent: percent,
        showBubbleSize: false,
      }
    : undefined;
const nameOf = (name: FileSeries["name"]): BarSeries["tx"] =>
  name === undefined
    ? undefined
    : "ref" in name
      ? { kind: "ref", ref: name.ref }
      : { kind: "literal", value: name.text };

function axisOf<A extends CategoryAxis | ValueAxis>(
  base: A,
  axis: FileAxis | undefined,
  gridlines: boolean,
): A {
  const scaling = {
    ...(axis?.reverse ? { orientation: "maxMin" as const } : {}),
    ...(axis?.min !== undefined ? { min: axis.min } : {}),
    ...(axis?.max !== undefined ? { max: axis.max } : {}),
    ...(axis?.log ? { logBase: 10 } : {}),
  };
  return {
    ...base,
    ...(Object.keys(scaling).length ? { scaling } : {}),
    ...(axis?.hidden ? { delete: true } : {}),
    ...(axis?.title ? { title: { text: axis.title } } : {}),
    ...(axis?.format ? { numFmt: { formatCode: axis.format, sourceLinked: false } } : {}),
    ...((axis?.gridlines ?? gridlines) ? { majorGridlines: true } : {}),
  };
}

/** A chart as Excel's chart part, ranges made absolute by `absolute`. */
export function chartReference(
  chart: FileChart,
  absolute: (ref: string) => string,
): ChartReference {
  const series = chart.series.map((each, index) => {
    const name = nameOf(
      each.name && "ref" in each.name ? { ref: absolute(each.name.ref) } : each.name,
    );
    return {
      idx: index,
      order: index,
      ...(name ? { tx: name } : {}),
      val: { ref: absolute(each.values) },
      ...(each.categories ? { cat: { ref: absolute(each.categories) } } : {}),
    };
  });
  const first = chart.series[0];
  if (chart.kind === "waterfall" || chart.kind === "histogram") {
    const cxSpace =
      chart.kind === "waterfall"
        ? makeWaterfallChart({
            ...(first?.categories ? { catRef: absolute(first.categories) } : {}),
            ...(first ? { valRef: absolute(first.values) } : {}),
          })
        : makeHistogramChart(first ? { valRef: absolute(first.values) } : {});
    if (chart.title) cxSpace.chart.title = { text: chart.title };
    return { cxSpace };
  }
  const percent = chart.kind === "pie" || chart.kind === "doughnut";
  const grouping =
    chart.stack === "stacked"
      ? ("stacked" as const)
      : chart.stack === "percent"
        ? ("percentStacked" as const)
        : undefined;
  const decorated = (each: (typeof series)[number], index: number, line: boolean) => {
    const own = chart.series[index]!;
    const spPr = shapeOf(own, line);
    const dLbls = labelsOf(own.labels ?? chart.labels ?? false, percent);
    return {
      ...each,
      ...(spPr ? { spPr } : {}),
      ...(dLbls ? { dLbls } : {}),
      ...(own.trendline ? { trendline: [{ trendlineType: "linear" as const }] } : {}),
    } satisfies BarSeries;
  };
  let plot: FileKind;
  switch (chart.kind) {
    case "column":
    case "bar":
      plot = makeBarChart({
        barDir: chart.kind === "column" ? "col" : "bar",
        ...(grouping ? { grouping, overlap: 100 } : {}),
        series: series.map((each, index) => decorated(each, index, false)),
        // Excel's gap is a share of a bar's width; ours of a whole band.
        ...(chart.gap !== undefined
          ? { gapWidth: Math.round((chart.gap / Math.max(0.05, 1 - chart.gap)) * 100) }
          : {}),
      });
      break;
    case "line":
      plot = makeLineChart({
        ...(grouping ? { grouping } : {}),
        series: series.map((each, index): LineSeries => {
          const own = chart.series[index]!;
          return {
            ...decorated(each, index, true),
            ...(own.smooth ? { smooth: true } : {}),
            marker: own.markers ? { symbol: "circle", size: 5 } : { symbol: "none" },
          };
        }),
      });
      break;
    case "area":
      plot = makeAreaChart({
        ...(grouping ? { grouping } : {}),
        series: series.map((each, index) => decorated(each, index, false)),
      });
      break;
    case "pie":
    case "doughnut": {
      const slices = series.slice(0, 1).map((each, index) => decorated(each, index, false));
      plot =
        chart.kind === "pie"
          ? makePieChart({ series: slices, varyColors: true })
          : makeDoughnutChart({
              series: slices,
              varyColors: true,
              holeSize: Math.round((chart.hole ?? 0.55) * 100),
            });
      break;
    }
    case "scatter":
    case "bubble": {
      const points = chart.series.map((own, index) => {
        const base = decorated(series[index]!, index, true);
        return {
          idx: base.idx,
          order: base.order,
          ...(base.tx ? { tx: base.tx } : {}),
          ...(base.dLbls ? { dLbls: base.dLbls } : {}),
          ...(base.trendline ? { trendline: base.trendline } : {}),
          yVal: base.val,
          ...(base.cat ? { xVal: { ref: base.cat.ref } } : {}),
          // Points only, as a scatter is drawn here.
          spPr: {
            ...shapeOf(own, true, true),
            ...(own.color ? { fill: solid(own.color) } : {}),
          },
          ...(chart.kind === "bubble" && own.sizes
            ? { bubbleSize: { ref: absolute(own.sizes) } }
            : {}),
        };
      });
      plot =
        chart.kind === "bubble"
          ? makeBubbleChart({
              series: points.flatMap(({ bubbleSize, ...each }) =>
                bubbleSize ? [{ ...each, bubbleSize }] : [],
              ),
            })
          : makeScatterChart({
              scatterStyle: "lineMarker",
              series: points.map((each) => ({
                ...each,
                marker: { symbol: "circle", size: 5 },
              })),
            });
      break;
    }
  }
  const ids = "axIds" in plot ? plot.axIds : undefined;
  const horizontal = chart.kind === "bar";
  const space: ChartSpace = makeChartSpace({
    plotArea: {
      chart: plot,
      ...(ids
        ? {
            // A bar chart's value axis runs along the bottom, its labels up the left.
            catAx: axisOf<CategoryAxis>(
              { axId: ids[0], crossAx: ids[1], position: horizontal ? "l" : "b" },
              horizontal ? chart.axes?.y : chart.axes?.x,
              false,
            ),
            valAx: axisOf<ValueAxis>(
              { axId: ids[1], crossAx: ids[0], position: horizontal ? "b" : "l" },
              horizontal ? chart.axes?.x : chart.axes?.y,
              true,
            ),
          }
        : {}),
    },
    ...(chart.title ? { title: chart.title } : {}),
    ...(chart.legend ? { legend: { position: LEGEND[chart.legend] } } : {}),
  });
  return { space };
}
