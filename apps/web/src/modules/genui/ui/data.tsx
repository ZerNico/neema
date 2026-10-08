// Data and drawing tags: tables, progress, charts and the SVG subset. Kept
// apart from tree.tsx because the chart library is heavy; both still load
// only with the lazy ui-block chunk.

import { areaY, barY, defineChart, lineY } from "@tanstack/charts";
import { group } from "@tanstack/charts/group";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { createElement, useMemo } from "react";
import { Progress, ProgressLabel } from "~/ui/primitives/progress";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import type { ValidNode } from "../catalog.ts";

/** Series colours, in fixed order and never cycled; the catalog caps series at four. */
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/** Catalog paint names to the app's theme variables. */
const PAINT: Record<string, string> = {
  none: "none",
  currentColor: "currentColor",
  primary: "var(--primary)",
  muted: "var(--muted-foreground)",
  success: "var(--success)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
  "chart-1": "var(--chart-1)",
  "chart-2": "var(--chart-2)",
  "chart-3": "var(--chart-3)",
  "chart-4": "var(--chart-4)",
};

const SVG_TAGS = new Set([
  "g",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "path",
  "text",
]);

const cellText = (value: unknown) => (value === null || value === undefined ? "" : String(value));

export function UiTable({ node }: { node: ValidNode }) {
  const columns = Array.isArray(node.props.columns) ? node.props.columns.map(String) : [];
  const rows = Array.isArray(node.props.rows) ? node.props.rows : [];
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- columns may repeat a name; position is the identity
            <TableHead key={`${i}-${column}`}>{column}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, r) => (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no identity beyond their position
          <TableRow key={r}>
            {columns.map((column, c) => (
              // oxlint-disable-next-line react/no-array-index-key -- columns may repeat a name; position is the identity
              <TableCell key={`${c}-${column}`}>
                {cellText(Array.isArray(row) ? row[c] : undefined)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function UiProgress({ node }: { node: ValidNode }) {
  const value = typeof node.props.value === "number" ? node.props.value : 0;
  const label = typeof node.props.label === "string" ? node.props.label : undefined;
  return (
    <Progress value={value} aria-label={label ?? "Progress"}>
      {label ? <ProgressLabel>{label}</ProgressLabel> : null}
    </Progress>
  );
}

interface Series {
  readonly name: string;
  readonly values: readonly (number | null)[];
}

function seriesOf(value: unknown): Series[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s: unknown) => {
    if (typeof s !== "object" || s === null || !("name" in s) || !("values" in s)) return [];
    const { name, values } = s;
    if (typeof name !== "string" || !Array.isArray(values)) return [];
    return [{ name, values: values.map((v: unknown) => (typeof v === "number" ? v : null)) }];
  });
}

export function UiChart({ node }: { node: ValidNode }) {
  const p = node.props;
  const type = p.type === "line" || p.type === "area" ? p.type : "bar";
  const unit = typeof p.unit === "string" ? p.unit : "";
  const label = typeof p.label === "string" ? p.label : "Chart";
  const stacked = p.stacked === true;
  const xs = useMemo(() => (Array.isArray(p.x) ? p.x.map(String) : []), [p.x]);
  const series = useMemo(() => seriesOf(p.series), [p.series]);
  const definition = useMemo(() => {
    const rows = series.flatMap((s) =>
      xs.map((x, i) => ({ x, series: s.name, value: s.values[i] ?? null })),
    );
    const many = series.length > 1;
    const marks =
      type === "line"
        ? lineY(rows, { x: "x", y: "value", z: "series", color: "series", strokeWidth: 2 })
        : type === "area"
          ? areaY(rows, {
              x: "x",
              y: "value",
              z: "series",
              color: "series",
              ...(stacked ? { layout: stack() } : {}),
            })
          : barY(rows, {
              x: "x",
              y: "value",
              z: "series",
              color: "series",
              radius: 2,
              inset: 1,
              ...(many ? { layout: stacked ? stack() : group() } : {}),
            });
    return defineChart({
      marks: [marks],
      scales: {
        x: { scale: () => scaleBand<string>().padding(0.25), axis: { line: false } },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { line: false, ticks: { format: (v) => `${String(v)}${unit}` } },
        },
      },
      color: { domain: series.map((s) => s.name), range: PALETTE.slice(0, series.length) },
      tooltip,
    });
  }, [series, xs, type, stacked, unit]);
  return (
    <figure className="flex flex-col gap-2">
      {series.length > 1 ? (
        <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          {series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: PALETTE[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground text-xs">
        <Chart definition={definition} height={240} ariaLabel={label} />
      </div>
    </figure>
  );
}

/** One SVG element from validated props; colours map to theme variables. */
function SvgNode({ node }: { node: ValidNode }) {
  if (!SVG_TAGS.has(node.tag)) return null;
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(node.props)) {
    props[name] =
      (name === "fill" || name === "stroke") && typeof value === "string" ? PAINT[value] : value;
  }
  const children = node.children.map((child, i) =>
    // oxlint-disable-next-line react/no-array-index-key -- drawing order is the identity
    typeof child === "string" ? child : <SvgNode key={i} node={child} />,
  );
  return createElement(node.tag, props, ...children);
}

export function UiSvg({ node }: { node: ValidNode }) {
  const label = typeof node.props.label === "string" ? node.props.label : "Drawing";
  const height = typeof node.props.height === "number" ? node.props.height : undefined;
  return (
    <svg
      viewBox={typeof node.props.viewBox === "string" ? node.props.viewBox : undefined}
      width="100%"
      height={height}
      role="img"
      aria-label={label}
      className="text-foreground block max-w-full"
    >
      {node.children.map((child, i) =>
        // oxlint-disable-next-line react/no-array-index-key -- drawing order is the identity
        typeof child === "string" ? null : <SvgNode key={i} node={child} />,
      )}
    </svg>
  );
}
