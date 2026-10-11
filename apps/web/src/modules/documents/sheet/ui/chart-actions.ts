import {
  Copy01Icon,
  Delete02Icon,
  Image01Icon,
  ImageDownloadIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import type { HugeiconsIconProps } from "@hugeicons/react";
import { positions, type Box, type SheetDoc } from "@chat/sheet/model";
import type { Chart } from "@chat/sheet/model/chart";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { GridDecoration } from "@chat/sheet-react/grid";
import { toast } from "sonner";
import { toastError } from "~/ui/error-toast.ts";
import { seriesColor } from "./chart-compile.ts";
import { chartFileName, chartPng, chartSvg, downloadBlob } from "./chart-image.ts";

const outline = (key: string, box: Box, color: string): GridDecoration => ({
  key,
  selection: { anchor: { r: box.r1, c: box.c1 }, head: { r: box.r2, c: box.c2 } },
  color,
});

/** The ranges a selected chart draws from, outlined as Excel does: names red, labels purple. */
export function chartDecorations(chart: Chart, sheet: string): GridDecoration[] {
  return chart.series.flatMap((series, index) => {
    if ((series.sheet ?? chart.sheet) !== sheet) return [];
    const name =
      series.name && "cell" in series.name && series.name.cell.sh === sheet
        ? series.name.cell
        : null;
    return [
      outline(`chart-values:${index}`, series.values, seriesColor(series, index)),
      ...(series.categories
        ? [outline(`chart-labels:${index}`, series.categories, "var(--chart-5)")]
        : []),
      ...(series.sizes ? [outline(`chart-sizes:${index}`, series.sizes, "var(--chart-7)")] : []),
      ...(name
        ? [
            outline(
              `chart-name:${index}`,
              { r1: name.r, r2: name.r, c1: name.c, c2: name.c },
              "var(--destructive)",
            ),
          ]
        : []),
    ];
  });
}

/** A copy of a chart a row and a column further on, as Excel offsets a duplicate. */
export function duplicateChart(doc: SheetDoc, chart: Chart, id: string): SheetOp {
  const rows = positions(doc.sheet[chart.sheet]!.rows);
  const cols = positions(doc.sheet[chart.sheet]!.cols);
  // `at` counts from 1, so it is already the index of the next row and column.
  const row = Math.min(rows.ids.length - 1, rows.at(chart.at.r) ?? 0);
  const col = Math.min(cols.ids.length - 1, cols.at(chart.at.c) ?? 0);
  return { op: "chartPut", id, chart: { ...chart, at: { r: rows.ids[row]!, c: cols.ids[col]! } } };
}

export type ChartAction = "edit" | "duplicate" | "png" | "svg" | "copy" | "delete";

export const CHART_ACTIONS: ReadonlyArray<{
  action: ChartAction;
  label: string;
  icon: HugeiconsIconProps["icon"];
  edits: boolean;
  separated?: boolean;
}> = [
  { action: "edit", label: "Edit chart", icon: PencilEdit02Icon, edits: true },
  { action: "duplicate", label: "Duplicate", icon: Copy01Icon, edits: true },
  {
    action: "png",
    label: "Download as PNG",
    icon: ImageDownloadIcon,
    edits: false,
    separated: true,
  },
  { action: "svg", label: "Download as SVG", icon: ImageDownloadIcon, edits: false },
  { action: "copy", label: "Copy as image", icon: Image01Icon, edits: false },
  { action: "delete", label: "Delete", icon: Delete02Icon, edits: true, separated: true },
];

/** The drawn chart's figure, from which its images are made. */
const figureOf = (id: string) =>
  document.querySelector<HTMLElement>(`[data-chart-id="${CSS.escape(id)}"]`);

/** Saves or copies a chart's image; the actions that change the sheet are the caller's. */
export async function chartImage(id: string, title: string | undefined, action: ChartAction) {
  const figure = figureOf(id);
  if (!figure) return;
  try {
    if (action === "svg")
      downloadBlob(
        new Blob([chartSvg(figure)], { type: "image/svg+xml;charset=utf-8" }),
        chartFileName(title, "svg"),
      );
    else if (action === "png") downloadBlob(await chartPng(figure), chartFileName(title, "png"));
    else if (action === "copy") {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": chartPng(figure) })]);
      toast("Chart copied");
    }
  } catch (error) {
    toastError(action === "copy" ? "Couldn’t copy the chart." : "Couldn’t save the chart.", error);
  }
}

export const chartActions = (readOnly: boolean) =>
  CHART_ACTIONS.filter((each) => !readOnly || !each.edits);
