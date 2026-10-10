import { areaY, barX, barY, defineChart, dot, lineY } from "@tanstack/charts";
import { group } from "@tanstack/charts/group";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import type { Chart as SheetChartSpec } from "@chat/sheet/model";
import type { ChartData } from "./chart-data.ts";

const PALETTE = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];
const colorOf = (index: number) => PALETTE[index % PALETTE.length]!;

const point = (at: number) => `${50 + 45 * Math.cos(at)} ${50 + 45 * Math.sin(at)}`;
/** A pie's slices as SVG paths, clockwise from twelve o'clock. */
function pieSlices(values: readonly number[]) {
  const total = values.reduce((sum, value) => sum + value, 0);
  const sweeps = values.map((value) => (total ? (value / total) * Math.PI * 2 : 0));
  return sweeps.map((sweep, index) => {
    const start = -Math.PI / 2 + sweeps.slice(0, index).reduce((sum, each) => sum + each, 0);
    const end = start + sweep;
    // A whole circle cannot be one arc: two halves draw it.
    const path =
      sweep >= Math.PI * 2 - 1e-9
        ? "M 5 50 A 45 45 0 1 1 95 50 A 45 45 0 1 1 5 50 Z"
        : `M 50 50 L ${point(start)} A 45 45 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(end)} Z`;
    return { path, id: `slice-${index}`, color: colorOf(index) };
  });
}

/** A pie, drawn here as a few arcs with its legend beside it. */
function Pie({ data, label }: { data: ChartData; label: string }) {
  const slices = pieSlices((data.series[0]?.values ?? []).map((value) => Math.max(0, value ?? 0)));
  const legend = data.categories
    .slice(0, 12)
    .map((category, at) => ({ category, id: `legend-${at}`, color: colorOf(at) }));
  return (
    <div className="flex h-full items-center gap-3">
      <svg viewBox="0 0 100 100" role="img" aria-label={label} className="h-full max-h-full">
        {slices.map((slice) => (
          <path key={slice.id} d={slice.path} fill={slice.color} />
        ))}
      </svg>
      <ul className="text-muted-foreground flex min-w-0 flex-col gap-1 text-xs">
        {legend.map((entry) => (
          <li key={entry.id} className="flex items-center gap-1.5 truncate">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            {entry.category}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A sheet's chart, drawn from its cells' current values. */
export function SheetChart({ chart, data }: { chart: SheetChartSpec; data: ChartData }) {
  const label = chart.title ?? "Chart";
  const height = Math.max(80, chart.size.height - (chart.title ? 56 : 32));
  // Each kind builds its own definition, typed by its own marks.
  const drawn = useMemo(() => {
    if (chart.kind === "pie") return <Pie data={data} label={label} />;
    const rows = data.series.flatMap((series) =>
      data.categories.map((x, index) => ({
        x,
        position: index + 1,
        series: series.name,
        value: series.values[index] ?? null,
      })),
    );
    const many = data.series.length > 1;
    const color = {
      domain: data.series.map((series) => series.name),
      range: data.series.map((_, index) => colorOf(index)),
    };
    const band = () => scaleBand<string>().padding(0.25);
    const linear = { scale: scaleLinear, nice: true, grid: true, axis: { line: false } };
    if (chart.kind === "bar")
      return (
        <Chart
          definition={defineChart({
            marks: [
              barX(rows, {
                x: "value",
                y: "x",
                z: "series",
                color: "series",
                radius: 2,
                ...(many ? { layout: group() } : {}),
              }),
            ],
            scales: { x: linear, y: { scale: band, axis: { line: false } } },
            color,
            tooltip,
          })}
          height={height}
          ariaLabel={label}
        />
      );
    if (chart.kind === "scatter")
      return (
        <Chart
          definition={defineChart({
            marks: [dot(rows, { x: "position", y: "value", color: "series" })],
            scales: { x: linear, y: linear },
            color,
            tooltip,
          })}
          height={height}
          ariaLabel={label}
        />
      );
    const marks =
      chart.kind === "line"
        ? lineY(rows, { x: "x", y: "value", z: "series", color: "series", strokeWidth: 2 })
        : chart.kind === "area"
          ? areaY(rows, { x: "x", y: "value", z: "series", color: "series" })
          : barY(rows, {
              x: "x",
              y: "value",
              z: "series",
              color: "series",
              radius: 2,
              inset: 1,
              ...(many ? { layout: group() } : {}),
            });
    return (
      <Chart
        definition={defineChart({
          marks: [marks],
          scales: {
            x: {
              scale: band,
              axis: { line: false, tickLabels: { thin: { minGap: 8, priority: "ends" } } },
            },
            y: linear,
          },
          color,
          tooltip,
        })}
        height={height}
        ariaLabel={label}
      />
    );
  }, [chart.kind, data, height, label]);
  return (
    <figure className="bg-background border-border flex h-full flex-col gap-1 rounded-md border p-3 shadow-sm">
      {chart.title ? <figcaption className="text-sm font-medium">{chart.title}</figcaption> : null}
      {data.series.length > 1 && chart.kind !== "pie" ? (
        <div className="text-muted-foreground flex flex-wrap gap-3 text-xs">
          {data.series.map((series, index) => (
            <span key={series.name} className="flex items-center gap-1.5">
              <span className="size-2 rounded-full" style={{ backgroundColor: colorOf(index) }} />
              {series.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground min-h-0 flex-1 text-xs">{drawn}</div>
    </figure>
  );
}
