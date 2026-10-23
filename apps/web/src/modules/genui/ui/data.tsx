// Data and drawing tags: tables, progress, charts and the SVG subset. Kept
// apart from tree.tsx because the chart library is heavy; both still load
// only with the lazy ui-block chunk.

import { formatNumber } from "./format.ts";
import { PIE_COLOURS, slicesOf, sortRows, type Cell, type Sort } from "./data-model.ts";
import { areaY, barY, defineChart, dot, lineY, ruleX, ruleY } from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { group } from "@tanstack/charts/group";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { ArrowDown01Icon, ArrowUp01Icon, ArrowUpDownIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createElement, useMemo, useState, type KeyboardEvent } from "react";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
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
import { handlerOf, useHandler } from "./handler.ts";

/** Series colours, in fixed order and never cycled; the catalog caps series at four. */
const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
/** A pie's folded Other: muted, so it reads as the remainder rather than a category. */
const OTHER_COLOUR = "var(--muted-foreground)";

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

const cellsOf = (row: unknown): Cell[] =>
  Array.isArray(row)
    ? row.map((v: unknown) => (typeof v === "number" || typeof v === "string" ? v : null))
    : [];

export function UiTable({ node }: { node: ValidNode }) {
  const p = node.props;
  const columns = Array.isArray(p.columns) ? p.columns.map(String) : [];
  const formats = Array.isArray(p.formats) ? p.formats : [];
  const sortable = p.sortable === true;
  // The order is the reader's view, like an open disclosure: kept while the block is on screen, never in its state.
  const [sort, setSort] = useState<Sort | null>(null);
  const rows = useMemo(
    () => sortRows(Array.isArray(p.rows) ? p.rows.map(cellsOf) : [], sort),
    [p.rows, sort],
  );
  const show = (value: Cell | undefined, c: number) => {
    const format = formats[c];
    return typeof value === "number"
      ? formatNumber(value, typeof format === "string" ? format : undefined)
      : cellText(value);
  };
  // A column is numeric when every filled cell is a number; it aligns right so digits line up.
  const numeric = columns.map((_, c) => {
    const filled = rows
      .map((row) => row[c])
      .filter((v) => v !== null && v !== undefined && v !== "");
    return filled.length > 0 && filled.every((v) => typeof v === "number");
  });
  const next = (column: number): Sort | null =>
    sort?.column !== column
      ? { column, descending: numeric[column] === true }
      : sort.descending === (numeric[column] === true)
        ? { column, descending: !sort.descending }
        : null;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column, i) => {
            const active = sort?.column === i;
            return (
              <TableHead
                // oxlint-disable-next-line react/no-array-index-key -- columns may repeat a name; position is the identity
                key={`${i}-${column}`}
                className={cn(numeric[i] && "text-right")}
                aria-sort={active ? (sort.descending ? "descending" : "ascending") : undefined}
              >
                {sortable ? (
                  <button
                    type="button"
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm hover:text-foreground",
                      numeric[i] && "flex-row-reverse",
                      focusRingClassName,
                    )}
                    onClick={() => setSort(next(i))}
                  >
                    {column}
                    <HugeiconsIcon
                      icon={
                        active
                          ? sort.descending
                            ? ArrowDown01Icon
                            : ArrowUp01Icon
                          : ArrowUpDownIcon
                      }
                      strokeWidth={2}
                      className={cn("size-3.5", !active && "text-muted-foreground/60")}
                      aria-hidden
                    />
                  </button>
                ) : (
                  column
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, r) => (
          // oxlint-disable-next-line react/no-array-index-key -- rows have no identity beyond their position
          <TableRow key={r}>
            {columns.map((column, c) => (
              <TableCell
                // oxlint-disable-next-line react/no-array-index-key -- columns may repeat a name; position is the identity
                key={`${c}-${column}`}
                className={cn(numeric[c] && "text-right tabular-nums")}
              >
                {show(row[c], c)}
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

interface Rule {
  readonly x?: string;
  readonly y?: number;
  readonly label?: string;
}

function rulesOf(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r: unknown) => {
    if (typeof r !== "object" || r === null) return [];
    const x =
      "x" in r && (typeof r.x === "string" || typeof r.x === "number") ? String(r.x) : undefined;
    const y = "y" in r && typeof r.y === "number" ? r.y : undefined;
    const label = "label" in r && typeof r.label === "string" ? r.label : undefined;
    if (x === undefined && y === undefined) return [];
    return [
      {
        ...(x !== undefined ? { x } : {}),
        ...(y !== undefined ? { y } : {}),
        ...(label ? { label } : {}),
      },
    ];
  });
}

/** Reference lines read as annotation, not data: muted and dashed. */
const RULE_STYLE = { stroke: "var(--muted-foreground)", strokeDasharray: "4 4", strokeWidth: 1.5 };

function PieChart({ node, donut }: { node: ValidNode; donut: boolean }) {
  const p = node.props;
  const format = typeof p.format === "string" ? p.format : undefined;
  const unit = typeof p.unit === "string" ? p.unit : "";
  const label = typeof p.label === "string" ? p.label : "Chart";
  const slices = useMemo(
    () => slicesOf(Array.isArray(p.x) ? p.x.map(String) : [], seriesOf(p.series)[0]?.values ?? []),
    [p.x, p.series],
  );
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const colours = useMemo(
    () => slices.map((_, i) => (i < PIE_COLOURS ? PALETTE[i]! : OTHER_COLOUR)),
    [slices],
  );
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          polar({
            inset: 8,
            radiusRatio: 0.9,
            marks: [
              radialArc(pie(slices, { value: "value", gapAngle: 0.01 }), {
                innerRadius: ({ radius }) => (donut ? radius * 0.6 : 0),
                cornerRadius: 3,
                color: "name",
                key: "name",
              }),
            ],
            scales: { angle: null, radius: null },
          }),
        ],
        scales: { x: null, y: null },
        color: { domain: slices.map((s) => s.name), range: colours },
        tooltip,
      }),
    [slices, colours, donut],
  );
  const amount = (value: number) => `${formatNumber(value, format)}${unit}`;
  return (
    <figure className="flex flex-wrap items-center gap-4">
      <div className="text-muted-foreground relative w-48 shrink-0 text-xs">
        <Chart definition={definition} height={192} ariaLabel={label} />
        {donut && total > 0 ? (
          <span className="text-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">
            {amount(total)}
          </span>
        ) : null}
      </div>
      {/* The legend is the chart's data in words: what a screen reader and a reader in a hurry both get. */}
      <ul className="flex min-w-40 flex-1 flex-col gap-1.5 text-sm">
        {slices.map((s, i) => (
          <li key={s.name} className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colours[i] }}
            />
            <span className="min-w-0 flex-1 truncate">{s.name}</span>
            <span className="tabular-nums">{amount(s.value)}</span>
            <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">
              {formatNumber(s.value / total, "percent")}
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Legend({ series, rules }: { series: readonly Series[]; rules: readonly Rule[] }) {
  if (series.length <= 1 && !rules.some((r) => r.label)) return null;
  return (
    <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
      {series.length > 1
        ? series.map((s, i) => (
            <span key={s.name} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: PALETTE[i] }} />
              {s.name}
            </span>
          ))
        : null}
      {rules.flatMap((r, i) =>
        r.label
          ? [
              // oxlint-disable-next-line react/no-array-index-key -- labels may repeat; position is the identity
              <span key={`rule-${i}`} className="flex items-center gap-1.5">
                <span className="border-muted-foreground w-3 border-t border-dashed" />
                {r.label}
              </span>,
            ]
          : [],
      )}
    </div>
  );
}

const strOf = (value: unknown) => (typeof value === "string" ? value : undefined);

/** The value axis, from the props every chart with axes shares. */
function yAxisOf(unit: unknown, format: unknown, label: unknown) {
  const suffix = strOf(unit) ?? "";
  const style = strOf(format);
  const title = strOf(label);
  return {
    scale: scaleLinear,
    nice: true,
    grid: true,
    axis: {
      line: false,
      ...(title ? { label: title } : {}),
      ticks: {
        format: (v: unknown) =>
          `${typeof v === "number" ? formatNumber(v, style, { axis: true }) : String(v)}${suffix}`,
      },
    },
  };
}

function ChartFigure({
  series,
  rules,
  label,
  definition,
}: {
  series: readonly Series[];
  rules: readonly Rule[];
  label: string;
  definition: Parameters<typeof Chart>[0]["definition"];
}) {
  return (
    <figure className="flex flex-col gap-2">
      <Legend series={series} rules={rules} />
      <div className="text-muted-foreground text-xs">
        <Chart definition={definition} height={240} ariaLabel={label} />
      </div>
    </figure>
  );
}

/** Both axes are measures: a point needs a number on each, and a rule on x is a value, not a category. */
function ScatterChart({ node }: { node: ValidNode }) {
  const p = node.props;
  const series = useMemo(() => seriesOf(p.series), [p.series]);
  const rules = useMemo(() => rulesOf(p.rules), [p.rules]);
  const definition = useMemo(() => {
    const xs: readonly unknown[] = Array.isArray(p.x) ? p.x : [];
    const xLabel = strOf(p.xLabel);
    const points = series.flatMap((s) =>
      xs.flatMap((x, i) => {
        const value = s.values[i];
        return typeof x === "number" && typeof value === "number"
          ? [{ x, series: s.name, value }]
          : [];
      }),
    );
    const levels = rules.filter((r) => r.y !== undefined);
    const marks = rules.flatMap((r) =>
      r.x !== undefined && Number.isFinite(Number(r.x)) ? [{ x: Number(r.x) }] : [],
    );
    return defineChart({
      marks: [
        dot(points, { x: "x", y: "value", color: "series", r: 4, fillOpacity: 0.8 }),
        ...(levels.length ? [ruleY(levels, { y: "y", ...RULE_STYLE })] : []),
        ...(marks.length ? [ruleX(marks, { x: "x", ...RULE_STYLE })] : []),
      ],
      scales: {
        x: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: {
            line: false,
            ...(xLabel ? { label: xLabel } : {}),
            ticks: {
              format: (v: unknown) =>
                typeof v === "number" ? formatNumber(v, undefined, { axis: true }) : String(v),
            },
          },
        },
        y: yAxisOf(p.unit, p.format, p.yLabel),
      },
      color: { domain: series.map((s) => s.name), range: PALETTE.slice(0, series.length) },
      tooltip,
    });
  }, [p.x, p.xLabel, p.yLabel, p.unit, p.format, series, rules]);
  return (
    <ChartFigure
      series={series}
      rules={rules}
      label={strOf(p.label) ?? "Chart"}
      definition={definition}
    />
  );
}

function CategoryChart({ node }: { node: ValidNode }) {
  const p = node.props;
  const type = p.type === "line" || p.type === "area" ? p.type : "bar";
  const stacked = p.stacked === true;
  const series = useMemo(() => seriesOf(p.series), [p.series]);
  const rules = useMemo(() => rulesOf(p.rules), [p.rules]);
  const definition = useMemo(() => {
    const xs = Array.isArray(p.x) ? p.x.map(String) : [];
    const xLabel = strOf(p.xLabel);
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
    const levels = rules.filter((r) => r.y !== undefined);
    const categories = rules.filter((r) => r.x !== undefined && xs.includes(r.x));
    return defineChart({
      marks: [
        marks,
        ...(levels.length ? [ruleY(levels, { y: "y", ...RULE_STYLE })] : []),
        ...(categories.length ? [ruleX(categories, { x: "x", ...RULE_STYLE })] : []),
      ],
      scales: {
        x: {
          scale: () => scaleBand<string>().padding(0.25),
          // Thirty-five years side by side are unreadable; keep the ends and space the rest.
          axis: {
            line: false,
            ...(xLabel ? { label: xLabel } : {}),
            tickLabels: { thin: { minGap: 8, priority: "ends" } },
          },
        },
        y: yAxisOf(p.unit, p.format, p.yLabel),
      },
      color: { domain: series.map((s) => s.name), range: PALETTE.slice(0, series.length) },
      tooltip,
    });
  }, [p.x, p.xLabel, p.yLabel, p.unit, p.format, series, type, stacked, rules]);
  return (
    <ChartFigure
      series={series}
      rules={rules}
      label={strOf(p.label) ?? "Chart"}
      definition={definition}
    />
  );
}

export function UiChart({ node }: { node: ValidNode }) {
  return node.props.type === "pie" || node.props.type === "donut" ? (
    <PieChart node={node} donut={node.props.type === "donut"} />
  ) : node.props.type === "scatter" ? (
    <ScatterChart node={node} />
  ) : (
    <CategoryChart node={node} />
  );
}

/** One SVG element from validated props; colours map to theme variables. */
function SvgNode({ node }: { node: ValidNode }) {
  const { onclick, label, ...rest } = node.props;
  const fire = useHandler(handlerOf(onclick), { event: "click", tag: "shape" });
  if (!SVG_TAGS.has(node.tag)) return null;
  const props: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rest)) {
    props[name] =
      (name === "fill" || name === "stroke") && typeof value === "string" ? PAINT[value] : value;
  }
  if (fire) {
    // A real control: focusable, named, and pressed by keyboard as by pointer.
    Object.assign(props, {
      role: "button",
      tabIndex: 0,
      "aria-label": typeof label === "string" ? label : "Select",
      className: "cursor-pointer outline-none focus-visible:[outline:2px_solid_var(--ring)]",
      onClick: () => fire([]),
      onKeyDown: (event: KeyboardEvent<SVGElement>) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        fire([]);
      },
    });
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
