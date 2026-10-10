import { Chart } from "@tanstack/charts/react";
import { useMemo, useState } from "react";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Chart as ChartSpec, ChartData } from "@chat/sheet/model/chart";
import { cn } from "~/ui/utils";
import { CHART_PALETTE, compileChart, seriesColor } from "./chart-compile.ts";

/** One legend entry: a series, or for a pie each slice. */
interface LegendItem {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  /** The series it hides and shows; slices are not toggled. */
  readonly series: number | null;
}

/**
 * A sheet's chart as people see it: the title and legend in the page, the
 * plot from the chart library. A legend entry hides and shows its series
 * for this reader only, as Excel's chart filter does.
 */
export function SheetChart({
  chart,
  data,
  locale,
}: {
  chart: ChartSpec;
  data: ChartData;
  locale: SheetLocale;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const pie = chart.kind === "pie" || chart.kind === "doughnut";
  const legend: LegendItem[] = pie
    ? data.categories.slice(0, 24).map((category, at) => ({
        key: `slice-${at}`,
        label: category,
        color: CHART_PALETTE[at % CHART_PALETTE.length]!,
        series: null,
      }))
    : data.series.map((series, index) => ({
        key: `series-${index}`,
        label: series.name,
        color: seriesColor(chart.series[index], index),
        series: index,
      }));
  const place = chart.legend ?? "none";
  const empty = data.series.every(
    (series) => series.broken || series.values.every((value) => value === null),
  );
  const definition = useMemo(
    () => (empty ? null : compileChart({ chart, data, locale, hidden })),
    [chart, data, locale, hidden, empty],
  );
  const toggle = (index: number | null) => {
    if (index === null) return;
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };
  const legendList =
    place === "none" || legend.length === 0 ? null : (
      <ul
        className={cn(
          "text-muted-foreground flex min-w-0 gap-x-3 gap-y-1 text-xs",
          place === "left" || place === "right"
            ? "max-w-[35%] flex-col"
            : "flex-wrap justify-center",
        )}
      >
        {legend.map((item) => {
          const off = item.series !== null && hidden.has(item.series);
          return (
            <li key={item.key} className="min-w-0">
              <button
                type="button"
                disabled={item.series === null}
                aria-pressed={item.series === null ? undefined : !off}
                className={cn(
                  "flex max-w-full items-center gap-1.5 truncate rounded-sm",
                  off && "line-through opacity-50",
                )}
                onClick={() => toggle(item.series)}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span className="truncate">{item.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  const titleHeight = (data.title ? 22 : 0) + (data.subtitle ? 18 : 0);
  const legendHeight = place === "top" || place === "bottom" ? 22 : 0;
  const plotHeight = Math.max(80, chart.size.height - 26 - titleHeight - legendHeight);
  const broken = data.series.some((series) => series.broken);
  return (
    <figure className="bg-background border-border flex h-full flex-col gap-1 overflow-hidden rounded-md border p-3 shadow-sm">
      {data.title || data.subtitle ? (
        <figcaption className="flex flex-col">
          {data.title ? <span className="truncate text-sm font-medium">{data.title}</span> : null}
          {data.subtitle ? (
            <span className="text-muted-foreground truncate text-xs">{data.subtitle}</span>
          ) : null}
        </figcaption>
      ) : null}
      {place === "top" ? legendList : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 items-center gap-3",
          place === "left" && "flex-row-reverse",
        )}
      >
        <div className="text-muted-foreground min-w-0 flex-1 text-xs">
          {definition ? (
            <Chart definition={definition} height={plotHeight} ariaLabel={data.title ?? "Chart"} />
          ) : (
            <p className="text-muted-foreground flex h-full items-center justify-center text-xs">
              {broken ? "Its cells were deleted" : "No numbers to chart yet"}
            </p>
          )}
        </div>
        {place === "left" || place === "right" ? legendList : null}
      </div>
      {place === "bottom" ? legendList : null}
    </figure>
  );
}
