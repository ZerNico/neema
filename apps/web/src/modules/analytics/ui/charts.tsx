import { areaY, barX, barY, defineChart, lineY } from "@tanstack/charts";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import type { UsageByModel, UsageDay } from "../server/repo.ts";
import { windowDays, type UsageWindow } from "../server/range.ts";
import { formatDay, formatTokens } from "./format.ts";
import { m } from "~/paraglide/messages.js";

// Definition identity is the chart's update boundary, so every definition
// below is memoized on its data. Colors come from the app's --chart-N tokens
// (validated for both surfaces); series order is fixed, never cycled.

const INK = "var(--color-muted-foreground)";

const EMPTY_DAY = {
  messages: 0,
  attempts: 0,
  errorAttempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  cost: 0,
  images: 0,
} as const;

/**
 * Sparse day rows from SQL, densified over the window the server actually
 * scanned, so a custom window that ended months ago renders its own days
 * rather than the last N ending today.
 */
const densify = (daily: readonly UsageDay[], window: UsageWindow): UsageDay[] => {
  const byDay = new Map(daily.map((row) => [row.day, row]));
  return windowDays(window).map((day) => byDay.get(day) ?? { day, ...EMPTY_DAY });
};

/**
 * Stacked token composition per day, four mutually exclusive series.
 *
 * Cached input is a *subset* of input and reasoning a subset of output, so the
 * stack subtracts rather than adds them; charting the raw four would double
 * count. Both subtractions clamp at zero in case a provider reports a subset
 * larger than its total.
 */
export function TokensPerDayChart({
  daily,
  window,
}: {
  daily: readonly UsageDay[];
  window: UsageWindow;
}) {
  const definition = useMemo(() => {
    const series = {
      input: m.analytics_series_input(),
      cached: m.analytics_series_cached(),
      output: m.analytics_series_output(),
      reasoning: m.analytics_series_reasoning(),
    };
    const rows = densify(daily, window).flatMap((row) => [
      {
        day: row.day,
        series: series.input,
        tokens: Math.max(row.inputTokens - row.cachedInputTokens, 0),
      },
      { day: row.day, series: series.cached, tokens: row.cachedInputTokens },
      {
        day: row.day,
        series: series.output,
        tokens: Math.max(row.outputTokens - row.reasoningTokens, 0),
      },
      { day: row.day, series: series.reasoning, tokens: row.reasoningTokens },
    ]);
    return defineChart({
      marks: [
        barY(rows, {
          x: "day",
          y: "tokens",
          z: "series",
          color: "series",
          layout: stack(),
          radius: 2,
          inset: 1,
        }),
      ],
      scales: {
        x: {
          scale: () => scaleBand<string>().padding(0.25),
          axis: {
            line: false,
            ticks: { format: (day) => formatDay(String(day)) },
            tickLabels: { thin: true },
          },
        },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { line: false, ticks: { format: (v) => formatTokens(Number(v)) } },
        },
      },
      // The legend is HTML in the card header, since the built-in one spreads its
      // items across the full chart width (itemWidth = width / columns).
      color: {
        domain: [series.input, series.cached, series.output, series.reasoning],
        range: ["var(--chart-1)", "var(--chart-3)", "var(--chart-2)", "var(--chart-4)"],
      },
      tooltip,
    });
  }, [daily, window]);

  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart definition={definition} height={240} ariaLabel={m.analytics_chart_tokens_label()} />
    </div>
  );
}

/** Single-series line, messages per day. No legend; the card title names it. */
export function MessagesPerDayChart({
  daily,
  window,
}: {
  daily: readonly UsageDay[];
  window: UsageWindow;
}) {
  const definition = useMemo(() => {
    const rows = densify(daily, window);
    return defineChart({
      marks: [lineY(rows, { x: "day", y: "messages", stroke: "var(--chart-1)", strokeWidth: 2 })],
      scales: {
        x: {
          scale: () => scaleBand<string>().padding(0.25),
          axis: {
            line: false,
            ticks: { format: (day) => formatDay(String(day)) },
            tickLabels: { thin: true },
          },
        },
        y: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { line: false },
        },
      },
      tooltip,
    });
  }, [daily, window]);

  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart definition={definition} height={200} ariaLabel={m.analytics_chart_messages()} />
    </div>
  );
}

const MAX_MODEL_BARS = 8;

// Only a name that a current model also uses needs telling apart.
export const modelLabels = (byModel: readonly UsageByModel[]) => {
  const current = new Set(byModel.filter((row) => row.linked).map((row) => row.modelName));
  return byModel.map((row) =>
    !row.linked && current.has(row.modelName)
      ? m.analytics_model_deleted({ name: row.modelName })
      : row.modelName,
  );
};

/**
 * Horizontal bars, total tokens by model. Magnitude comparison, so one hue;
 * identity lives in the row label, not in color. The tail beyond the top
 * eight folds into "Other"; the table next to it stays complete.
 */
export function TokensByModelChart({ byModel }: { byModel: readonly UsageByModel[] }) {
  const definition = useMemo(() => {
    const labels = modelLabels(byModel);
    const rows = byModel.map((row, index) => ({
      model: labels[index]!,
      tokens: row.inputTokens + row.outputTokens,
    }));
    const shown = rows.slice(0, MAX_MODEL_BARS);
    const tail = rows.slice(MAX_MODEL_BARS);
    if (tail.length > 0) {
      shown.push({
        model: m.analytics_model_other({ count: tail.length }),
        tokens: tail.reduce((sum, row) => sum + row.tokens, 0),
      });
    }
    return defineChart({
      marks: [barX(shown, { x: "tokens", y: "model", fill: "var(--chart-1)", radius: 2 })],
      scales: {
        x: {
          scale: scaleLinear,
          nice: true,
          grid: true,
          axis: { line: false, ticks: { format: (v) => formatTokens(Number(v)) } },
        },
        y: {
          scale: () => scaleBand<string>().padding(0.3),
          axis: { line: false },
        },
      },
      tooltip,
    });
  }, [byModel]);

  const height = Math.max(120, Math.min(byModel.length, MAX_MODEL_BARS + 1) * 36 + 40);
  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart
        definition={definition}
        height={height}
        ariaLabel={m.analytics_chart_by_model_label()}
      />
    </div>
  );
}

/**
 * A bare trend line for a KPI tile: no axes, grid, tooltip or focus ring.
 *
 * Decorative by design, since the tile's value and delta carry the meaning, so the
 * mark is hidden from assistive tech rather than given a label that would
 * repeat them. Below two points there is no trend to draw, so it renders
 * nothing rather than a single misleading dot.
 */
export function UsageSparkline({ values }: { values: readonly number[] }) {
  const definition = useMemo(() => {
    const rows = values.map((value, index) => ({ index, value }));
    return defineChart({
      marks: [
        areaY(rows, {
          x: "index",
          y: "value",
          fill: "var(--chart-1)",
          fillOpacity: 0.15,
          stroke: "var(--chart-1)",
          strokeWidth: 1.5,
        }),
      ],
      scales: {
        x: { scale: scaleLinear, axis: false },
        y: { scale: scaleLinear, axis: false, nice: false },
      },
      guides: false,
      margin: 0,
    });
  }, [values]);

  if (values.length < 2) return null;
  return (
    <div aria-hidden className="pointer-events-none">
      {/* Required by the lib; empty because the wrapper is aria-hidden and
          the tile's own value and delta already say this. */}
      <Chart definition={definition} width={72} height={22} ariaLabel="" />
    </div>
  );
}
