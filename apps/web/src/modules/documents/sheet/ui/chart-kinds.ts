import type { ChartKind } from "@chat/sheet-react/commands";

/** Chart kinds by name, in the order Excel's Insert menu lists them. */
export const CHART_KINDS: ReadonlyArray<{ kind: ChartKind; label: string }> = [
  { kind: "column", label: "Column" },
  { kind: "bar", label: "Bar" },
  { kind: "line", label: "Line" },
  { kind: "area", label: "Area" },
  { kind: "pie", label: "Pie" },
  { kind: "scatter", label: "Scatter" },
];
