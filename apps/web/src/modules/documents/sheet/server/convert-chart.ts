import { parseCell, parseRange } from "@chat/sheet/a1";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import {
  patchChart,
  readSource,
  rebuildSeries,
  type Chart,
  type ChartAxis,
  type ChartKind,
  type ChartLabels,
  type ChartPatch,
  type ChartSeries,
  type ChartStack,
  type LegendPlace,
  type ChartText,
} from "@chat/sheet/model/chart";
import type { Axis, Box, SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { CLEARABLE, LiveSheetOperation } from "../live-operations.ts";

type ChartOperation = Extract<LiveSheetOperation, { kind: "addChart" | "editChart" }>;
type AxisInput = NonNullable<ChartOperation["yAxis"]>;
type SeriesInput = NonNullable<ChartOperation["series"]>[number];

/** What the converter lends a chart operation: its current view and the ways it grows and refuses. */
export interface ChartTools {
  readonly view: () => SheetDoc;
  readonly sheetId: (name: string) => string;
  readonly ids: (sh: string, axis: Axis) => readonly string[];
  readonly ensure: (sh: string, rows: number, cols: number) => void;
  readonly mint: () => string;
  readonly context: CalcContext;
  readonly refuse: (message: string, outcome?: "not_found" | "invalid") => never;
}

const ONE_SERIES = new Set<ChartKind>(["pie", "doughnut", "waterfall", "histogram"]);

/** An axis with the given options merged in; empty text and false log clear theirs. */
function mergeAxis(
  current: ChartAxis | undefined,
  given: AxisInput,
  text: (typed: string) => ChartText | null,
): ChartAxis | null {
  const next: { -readonly [K in keyof ChartAxis]?: ChartAxis[K] } = { ...current };
  if (given.title !== undefined) {
    const title = text(given.title);
    if (title) next.title = title;
    else delete next.title;
  }
  if (given.min !== undefined) next.min = given.min;
  if (given.max !== undefined) next.max = given.max;
  if (given.format !== undefined) {
    if (given.format.trim()) next.format = given.format;
    else delete next.format;
  }
  if (given.log !== undefined) {
    if (given.log) next.log = true;
    else delete next.log;
  }
  if (given.gridlines !== undefined) next.gridlines = given.gridlines;
  return Object.keys(next).length ? next : null;
}

/**
 * An addChart or editChart as a chart operation. A range is read as Excel
 * reads a selection; listed series take their options as given; anything
 * not given keeps what the chart had.
 */
export function chartOperation(operation: ChartOperation, tools: ChartTools): SheetOp {
  const existing =
    operation.kind === "editChart" ? tools.view().charts[operation.chart] : undefined;
  if (operation.kind === "editChart" && !existing)
    tools.refuse(`No chart ${operation.chart}; the view lists them in <charts>.`, "not_found");
  const home = operation.kind === "addChart" ? tools.sheetId(operation.sheet) : existing!.sheet;

  /** A range on the chart's sheet unless it names one, as IDs, the grid grown to hold it. */
  const reference = (text: string, field: string) => {
    const bang = text.lastIndexOf("!");
    const on =
      bang === -1
        ? home
        : tools.sheetId(
            text
              .slice(0, bang)
              .replace(/^'(.*)'$/, "$1")
              .replaceAll("''", "'"),
          );
    const box = parseRange((bang === -1 ? text : text.slice(bang + 1)).replaceAll("$", ""));
    if (!box) return tools.refuse(`${field}: "${text}" is not a range like Data!B2:B13.`);
    tools.ensure(on, box.bottom, box.right);
    const rows = tools.ids(on, "rows");
    const cols = tools.ids(on, "columns");
    const ids: Box = {
      r1: rows[box.top - 1]!,
      r2: rows[box.bottom - 1]!,
      c1: cols[box.left - 1]!,
      c2: cols[box.right - 1]!,
    };
    return { sheet: on, box: ids };
  };
  /** Chart text as given: "=B1" follows that cell, empty clears. */
  const text = (typed: string): ChartText | null => {
    const trimmed = typed.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith("=")) return { text: trimmed };
    const ref = reference(trimmed.slice(1), "text");
    if (ref.box.r1 !== ref.box.r2 || ref.box.c1 !== ref.box.c2)
      tools.refuse(`"${typed}" names a range; chart text follows one cell, like =B1.`);
    return { cell: { sh: ref.sheet, r: ref.box.r1, c: ref.box.c1 } };
  };

  const kind = (operation.type ?? existing?.kind) as ChartKind;
  const patch: { -readonly [K in keyof ChartPatch]?: ChartPatch[K] } = {};
  if (operation.type) patch.kind = kind;

  // ---- what it draws: a range read as Excel would, or series as listed
  const categories = operation.categories ? reference(operation.categories, "categories") : null;
  if (operation.range) {
    const range = reference(operation.range, "range");
    const values = calculateSheet(tools.view(), tools.context);
    const source = readSource(tools.view(), values, range.sheet, range.box);
    const base: Chart = existing ?? {
      sheet: home,
      at: { r: "", c: "" },
      size: { width: 0, height: 0 },
      kind,
      series: [],
    };
    const rebuilt = rebuildSeries(tools.view(), { ...base, kind }, source, values);
    if (!rebuilt.series.length)
      tools.refuse(`range: ${operation.range} holds nothing to chart; give a range with numbers.`);
    patch.series = rebuilt.series;
    patch.source = source;
  } else if (operation.series) {
    patch.series = operation.series.map((each: SeriesInput, index): ChartSeries => {
      const values = reference(each.values, `series[${index}].values`);
      if (categories && categories.sheet !== values.sheet)
        tools.refuse("A series and its categories are on one sheet.");
      const name = each.name === undefined ? null : text(each.name);
      const line = {
        ...(each.smooth ? { smooth: true } : {}),
        ...(each.markers ? { markers: true } : {}),
        ...(each.dashed ? { dashed: true } : {}),
      };
      return {
        values: values.box,
        ...(values.sheet === home ? {} : { sheet: values.sheet }),
        ...(categories ? { categories: categories.box } : {}),
        ...(each.sizes ? { sizes: reference(each.sizes, `series[${index}].sizes`).box } : {}),
        ...(name ? { name } : {}),
        ...(each.color ? { color: each.color } : {}),
        ...(each.as ? { kind: each.as as "column" | "line" | "area" } : {}),
        ...(each.axis === "right" ? { axis: "right" as const } : {}),
        ...(each.labels ? { labels: { show: true } } : {}),
        ...(Object.keys(line).length ? { line } : {}),
        ...(each.trendline ? { trendline: true } : {}),
      };
    });
    // Series listed by hand no longer follow the range they came from.
    if (existing?.source) patch.source = null;
  } else if (existing) {
    if (categories)
      patch.series = existing.series.map((each) => ({ ...each, categories: categories.box }));
    // A new kind reads its range again, so a pie keeps one series and columns get them all back.
    else if (operation.type && existing.source)
      patch.series = rebuildSeries(
        tools.view(),
        { ...existing, kind },
        existing.source,
        calculateSheet(tools.view(), tools.context),
      ).series;
  }
  const drawn = patch.series ?? existing?.series;
  if (ONE_SERIES.has(kind) && drawn && drawn.length > 1) patch.series = drawn.slice(0, 1);

  // ---- how it looks
  // The schema allowed only these options.
  if (operation.stack)
    patch.stack = operation.stack === "none" ? null : (operation.stack as ChartStack);
  if (operation.title !== undefined) patch.title = text(operation.title);
  if (operation.subtitle !== undefined) patch.subtitle = text(operation.subtitle);
  if (operation.legend)
    patch.legend = operation.legend === "none" ? null : (operation.legend as LegendPlace);
  const axes: { -readonly [K in "x" | "y" | "y2"]?: ChartAxis | null } = {};
  for (const [key, given] of [
    ["x", operation.xAxis],
    ["y", operation.yAxis],
    ["y2", operation.rightAxis],
  ] as const)
    if (given) axes[key] = mergeAxis(existing?.axes?.[key], given, text);
  if (Object.keys(axes).length) patch.axes = axes;
  const style: { hole?: number; labels?: ChartLabels | null } = {};
  if (operation.hole !== undefined) style.hole = operation.hole;
  if (operation.labels !== undefined)
    style.labels = operation.labels
      ? { show: true, ...(kind === "pie" || kind === "doughnut" ? { content: "percent" } : {}) }
      : null;
  if (Object.keys(style).length) patch.style = style;
  if (operation.width || operation.height)
    patch.size = {
      width: operation.width ?? existing?.size.width ?? 480,
      height: operation.height ?? existing?.size.height ?? 300,
    };
  if (operation.at) {
    const at = parseCell(operation.at)!;
    tools.ensure(home, at.row, at.column);
    patch.at = {
      r: tools.ids(home, "rows")[at.row - 1]!,
      c: tools.ids(home, "columns")[at.column - 1]!,
    };
    // Moved by the model, it sits on the cell's corner.
    if (operation.kind === "editChart") patch.offset = null;
  }

  if (operation.kind === "editChart") {
    const cleared: Record<(typeof CLEARABLE)[number], () => ChartPatch> = {
      title: () => ({ title: null }),
      subtitle: () => ({ subtitle: null }),
      stack: () => ({ stack: null }),
      legend: () => ({ legend: null }),
      xAxis: () => ({ axes: { ...patch.axes, x: null } }),
      yAxis: () => ({ axes: { ...patch.axes, y: null } }),
      rightAxis: () => ({ axes: { ...patch.axes, y2: null } }),
      labels: () => ({ style: { ...patch.style, labels: null } }),
      hole: () => ({ style: { ...patch.style, hole: null } }),
    };
    // The schema allowed only these names.
    for (const option of operation.clear ?? [])
      Object.assign(patch, cleared[option as (typeof CLEARABLE)[number]]());
    return { op: "chartPatch", id: operation.chart, patch };
  }
  const series = patch.series ?? [];
  const chart = patchChart(
    {
      sheet: home,
      at: patch.at!,
      size: { width: 480, height: 300 },
      kind,
      series,
      // As Excel does: a legend when there is more than one thing to tell apart.
      ...(series.length > 1 || kind === "pie" || kind === "doughnut" ? { legend: "bottom" } : {}),
    },
    patch,
  );
  return { op: "chartPut", id: tools.mint(), chart };
}
