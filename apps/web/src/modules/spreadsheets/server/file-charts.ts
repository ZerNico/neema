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
  type ChartTitle,
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
  type DrawingItem,
  type ShapeProperties,
} from "@office-kit/xlsx/drawing";

/**
 * A chart as a file keeps it: ranges as A1 text naming their sheet, placed by
 * cell and pixels. Live sheets export to it and import from it, and the
 * Excel tools build theirs through it, so one mapping to Excel's chart parts
 * serves all three.
 */
export interface FileChart {
  readonly sheet: string;
  readonly at: string;
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
const EMU_PER_PIXEL = 9_525;

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

const textOf = (title: ChartTitle | undefined) =>
  title?.text ??
  title?.tx?.paragraphs
    .map((paragraph) =>
      paragraph.runs.map((run) => ("t" in run && typeof run.t === "string" ? run.t : "")).join(""),
    )
    .join(" ")
    .trim() ??
  undefined;
const readAxis = (axis: CategoryAxis | ValueAxis | undefined): FileAxis | undefined => {
  if (!axis) return undefined;
  const title = textOf(axis.title);
  const read: FileAxis = {
    ...(title ? { title } : {}),
    ...(axis.scaling?.min !== undefined ? { min: axis.scaling.min } : {}),
    ...(axis.scaling?.max !== undefined ? { max: axis.scaling.max } : {}),
    ...(axis.scaling?.logBase ? { log: true } : {}),
    ...(axis.scaling?.orientation === "maxMin" ? { reverse: true } : {}),
    ...(axis.delete ? { hidden: true } : {}),
    ...(axis.numFmt && !axis.numFmt.sourceLinked && axis.numFmt.formatCode !== "General"
      ? { format: axis.numFmt.formatCode }
      : {}),
    ...(axis.majorGridlines ? { gridlines: true } : {}),
  };
  return Object.keys(read).length ? read : undefined;
};
const colorOf = (shape: ShapeProperties | undefined) => {
  const fill = shape?.fill ?? shape?.ln?.fill;
  return fill?.kind === "solidFill" && fill.color.base.kind === "srgb"
    ? `#${fill.color.base.value.toUpperCase()}`
    : undefined;
};
const columnPx = 64;
const rowPx = 20;
const cellRef = (row: number, col: number) => {
  let letters = "";
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  return `${letters}${row + 1}`;
};

/**
 * A chart Excel wrote, read back as a file chart; null for a kind a live
 * sheet does not draw (radar, stock, surface, 3-D and the like).
 */
export function readFileChart(sheet: string, item: DrawingItem): FileChart | null {
  if (item.content.kind !== "chart") return null;
  const { anchor } = item;
  if (anchor.kind === "absolute") return null;
  const from = anchor.from;
  const [width, height] =
    anchor.kind === "oneCell"
      ? [anchor.ext.cx / EMU_PER_PIXEL, anchor.ext.cy / EMU_PER_PIXEL]
      : [
          (anchor.to.col - from.col) * columnPx + (anchor.to.colOff - from.colOff) / EMU_PER_PIXEL,
          (anchor.to.row - from.row) * rowPx + (anchor.to.rowOff - from.rowOff) / EMU_PER_PIXEL,
        ];
  const place = {
    sheet,
    at: cellRef(from.row, from.col),
    width: Math.round(Math.min(2000, Math.max(160, width))),
    height: Math.round(Math.min(1600, Math.max(120, height))),
  };
  const { cxSpace, space } = item.content.chart;
  if (cxSpace) {
    const series = cxSpace.chart.plotArea.series[0];
    const kind =
      series?.layoutId === "waterfall"
        ? "waterfall"
        : series?.layoutId === "clusteredColumn" && series.layoutPr?.kind === "binning"
          ? "histogram"
          : null;
    const data = cxSpace.chartData.data.find((each) => each.id === (series?.dataId ?? 0));
    const values = data?.dims.find((dim) => dim.kind === "num")?.f;
    const categories = data?.dims.find((dim) => dim.kind === "str")?.f;
    if (!kind || !values) return null;
    return {
      ...place,
      kind,
      ...(cxSpace.chart.title?.text ? { title: cxSpace.chart.title.text } : {}),
      series: [{ values, ...(categories ? { categories } : {}) }],
    };
  }
  if (!space) return null;
  const plot = space.plotArea.chart;
  const grouping =
    "grouping" in plot
      ? plot.grouping === "stacked"
        ? { stack: "stacked" as const }
        : plot.grouping === "percentStacked"
          ? { stack: "percent" as const }
          : {}
      : {};
  const kind =
    plot.kind === "bar"
      ? plot.barDir === "col"
        ? "column"
        : "bar"
      : plot.kind === "line" ||
          plot.kind === "area" ||
          plot.kind === "pie" ||
          plot.kind === "doughnut" ||
          plot.kind === "scatter" ||
          plot.kind === "bubble"
        ? plot.kind
        : null;
  if (!kind) return null;
  const read = plot.series.flatMap((each): FileSeries[] => {
    const values = "val" in each ? each.val?.ref : "yVal" in each ? each.yVal.ref : undefined;
    if (!values) return [];
    const categories = "cat" in each ? each.cat?.ref : "xVal" in each ? each.xVal?.ref : undefined;
    const name =
      each.tx?.kind === "literal"
        ? { text: each.tx.value }
        : each.tx?.kind === "ref"
          ? { ref: each.tx.ref }
          : undefined;
    const color = colorOf(each.spPr);
    const marker = "marker" in each ? each.marker : undefined;
    return [
      {
        values,
        ...(categories ? { categories } : {}),
        ...("bubbleSize" in each && each.bubbleSize.ref ? { sizes: each.bubbleSize.ref } : {}),
        ...(name ? { name } : {}),
        ...(color ? { color } : {}),
        ...(each.dLbls && !each.dLbls.delete && (each.dLbls.showVal || each.dLbls.showPercent)
          ? { labels: true }
          : {}),
        ...("smooth" in each && each.smooth ? { smooth: true } : {}),
        ...(kind === "line" && marker && marker.symbol !== "none" ? { markers: true } : {}),
        ...(each.spPr?.ln?.dash ? { dashed: true } : {}),
        ...(each.trendline?.length ? { trendline: true } : {}),
      },
    ];
  });
  if (!read.length) return null;
  const horizontal = kind === "bar";
  const [x, y] = horizontal
    ? [readAxis(space.plotArea.valAx), readAxis(space.plotArea.catAx)]
    : [readAxis(space.plotArea.catAx), readAxis(space.plotArea.valAx)];
  const title = textOf(space.title);
  const legend = space.legend
    ? (Object.entries(LEGEND).find(([, code]) => code === space.legend!.position)?.[0] ?? "right")
    : undefined;
  return {
    ...place,
    kind,
    ...grouping,
    ...(title ? { title } : {}),
    ...(legend ? { legend: legend as NonNullable<FileChart["legend"]> } : {}),
    ...(x || y ? { axes: { ...(x ? { x } : {}), ...(y ? { y } : {}) } } : {}),
    ...(plot.kind === "doughnut" && plot.holeSize ? { hole: plot.holeSize / 100 } : {}),
    ...(plot.kind === "bar" && plot.gapWidth !== undefined
      ? { gap: plot.gapWidth / (100 + plot.gapWidth) }
      : {}),
    series: kind === "pie" || kind === "doughnut" ? read.slice(0, 1) : read,
  };
}
