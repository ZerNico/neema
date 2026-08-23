import { barX, barY, defineChart, lineY } from "@tanstack/charts";
import { colorLegend } from "@tanstack/charts/legend";
import { Chart } from "@tanstack/charts/react";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { stack } from "@tanstack/charts/stack";
import { tooltip } from "@tanstack/charts/tooltip";
import { useMemo } from "react";
import type { UsageByModel, UsageDay } from "../server/repo.ts";
import { formatDay, formatTokens, lastDays } from "./format.ts";

// Definition identity is the chart's update boundary, so every definition
// below is memoized on its data. Colors come from the app's --chart-N tokens
// (validated for both surfaces); series order is fixed, never cycled.

const INK = "var(--color-muted-foreground)";

/** Sparse day rows from SQL, densified over the visible range with zeros. */
const densify = (daily: readonly UsageDay[], days: number): UsageDay[] => {
  const byDay = new Map(daily.map((row) => [row.day, row]));
  return lastDays(days).map(
    (day) => byDay.get(day) ?? { day, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 },
  );
};

/** Stacked input/output tokens per day — two fixed series, slots 1 and 2. */
export function TokensPerDayChart({ daily, days }: { daily: readonly UsageDay[]; days: number }) {
  const definition = useMemo(() => {
    const rows = densify(daily, days).flatMap((row) => [
      { day: row.day, series: "Input", tokens: row.inputTokens },
      { day: row.day, series: "Output", tokens: row.outputTokens },
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
      color: {
        domain: ["Input", "Output"],
        range: ["var(--chart-1)", "var(--chart-2)"],
        legend: colorLegend(),
      },
      tooltip,
    });
  }, [daily, days]);

  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart definition={definition} height={240} ariaLabel="Tokens per day, input and output" />
    </div>
  );
}

/** Single-series line — messages per day. No legend; the card title names it. */
export function MessagesPerDayChart({ daily, days }: { daily: readonly UsageDay[]; days: number }) {
  const definition = useMemo(() => {
    const rows = densify(daily, days);
    return defineChart({
      marks: [lineY(rows, { x: "day", y: "messages", stroke: "var(--chart-1)", strokeWidth: 2 })],
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
      tooltip,
    });
  }, [daily, days]);

  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart definition={definition} height={200} ariaLabel="Messages per day" />
    </div>
  );
}

const MAX_MODEL_BARS = 8;

/**
 * Horizontal bars, total tokens by model. Magnitude comparison, so one hue —
 * identity lives in the row label, not in color. The tail beyond the top
 * eight folds into "Other"; the table next to it stays complete.
 */
export function TokensByModelChart({ byModel }: { byModel: readonly UsageByModel[] }) {
  const definition = useMemo(() => {
    const rows = byModel.map((row) => ({
      model: row.modelName,
      tokens: row.inputTokens + row.outputTokens,
    }));
    const shown = rows.slice(0, MAX_MODEL_BARS);
    const tail = rows.slice(MAX_MODEL_BARS);
    if (tail.length > 0) {
      shown.push({
        model: `Other (${tail.length})`,
        tokens: tail.reduce((sum, row) => sum + row.tokens, 0),
      });
    }
    return defineChart({
      marks: [barX(shown, { x: "tokens", y: "model", fill: "var(--chart-1)", radius: 2 })],
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
      tooltip,
    });
  }, [byModel]);

  const height = Math.max(120, Math.min(byModel.length, MAX_MODEL_BARS + 1) * 36 + 40);
  return (
    <div style={{ color: INK }} className="text-xs">
      <Chart definition={definition} height={height} ariaLabel="Total tokens by model" />
    </div>
  );
}
