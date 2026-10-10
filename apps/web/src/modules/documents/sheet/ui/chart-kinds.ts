import {
  ChartAreaIcon,
  ChartBarBigIcon,
  ChartBubble01Icon,
  ChartColumnIcon,
  ChartColumnIncreasingIcon,
  ChartHistogramIcon,
  ChartLineData01Icon,
  PieChartIcon,
  ChartRingIcon,
  ChartScatterIcon,
} from "@hugeicons/core-free-icons";
import type { HugeiconsIconProps } from "@hugeicons/react";
import type { ChartKind } from "@chat/sheet/model/chart";

/** Chart kinds by name, in the order Excel's Insert menu lists them. */
export const CHART_KINDS: ReadonlyArray<{
  kind: ChartKind;
  label: string;
  icon: HugeiconsIconProps["icon"];
}> = [
  { kind: "column", label: "Column", icon: ChartColumnIcon },
  { kind: "bar", label: "Bar", icon: ChartBarBigIcon },
  { kind: "line", label: "Line", icon: ChartLineData01Icon },
  { kind: "area", label: "Area", icon: ChartAreaIcon },
  { kind: "pie", label: "Pie", icon: PieChartIcon },
  { kind: "doughnut", label: "Doughnut", icon: ChartRingIcon },
  { kind: "scatter", label: "Scatter", icon: ChartScatterIcon },
  { kind: "bubble", label: "Bubble", icon: ChartBubble01Icon },
  { kind: "waterfall", label: "Waterfall", icon: ChartColumnIncreasingIcon },
  { kind: "histogram", label: "Histogram", icon: ChartHistogramIcon },
];

/** Kinds that stack their series, stacked or to a hundred percent. */
export const STACKING: ReadonlySet<ChartKind> = new Set(["column", "bar", "area"]);
/** Kinds whose series may each be drawn as a column, line or area, on either side's axis. */
export const COMBINING: ReadonlySet<ChartKind> = new Set(["column", "line", "area"]);
/** Kinds that draw one series only. */
export const SINGLE: ReadonlySet<ChartKind> = new Set([
  "pie",
  "doughnut",
  "waterfall",
  "histogram",
]);
