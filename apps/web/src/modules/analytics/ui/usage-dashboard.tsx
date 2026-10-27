import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { useMemo, useState, type ReactNode } from "react";
import type { DateRange } from "react-day-picker";
import type { UsageByModel, UsageByUser, UsageDay, UsageSummary } from "../server/repo.ts";
import type { UsageWindow } from "../server/range.ts";
import type { UsageRangeDays, UsageRangeEncoded } from "../schema.ts";
import {
  MessagesPerDayChart,
  modelLabels,
  TokensByModelChart,
  TokensPerDayChart,
  UsageSparkline,
} from "./charts.tsx";
import {
  formatCost,
  formatCostPerMillion,
  formatCount,
  formatPercent,
  formatPointDelta,
  formatRangeLabel,
  formatRelativeDelta,
  formatTokens,
} from "./format.ts";
import { Button } from "~/ui/primitives/button";
import { Calendar } from "~/ui/primitives/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "~/ui/primitives/popover";
import { Separator } from "~/ui/primitives/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
import { Card, CardContent, CardHeader } from "~/ui/card.tsx";
import { cn } from "~/ui/utils";
import { m } from "~/paraglide/messages.js";

const usageRanges = (): Array<{ value: UsageRangeDays; label: string }> => [
  { value: 7, label: m.analytics_range_last_7() },
  { value: 30, label: m.analytics_range_last_30() },
  { value: 90, label: m.analytics_range_last_90() },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build the UTC boundary from the calendar's own y/m/d fields.
 *
 * `react-day-picker` hands back a *local* midnight; calling `.toISOString()`
 * on that lands on the previous or next day for anyone east or west of UTC,
 * silently shifting the range by a day.
 */
const utcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));

const toCustomRange = (range: DateRange): UsageRangeEncoded | null => {
  if (!range.from || !range.to) return null;
  return {
    kind: "custom",
    from: utcDay(range.from).toISOString(),
    // The picker's end day is inclusive; the window's `to` is exclusive.
    to: new Date(utcDay(range.to).getTime() + DAY_MS).toISOString(),
  };
};

// The preset list lives in a Popover (the calendar swaps into the same
// surface), so the rows borrow DropdownMenuItem's look and focus ring.
const PRESET_ROW =
  "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground flex w-full items-center rounded-2xl px-3 py-2 text-left text-sm font-medium transition-colors outline-none select-none";

const rangeLabel = (range: UsageRangeEncoded): string =>
  range.kind === "preset"
    ? (usageRanges().find((r) => r.value === range.days)?.label ??
      m.analytics_range_last_days({ count: range.days }))
    : formatRangeLabel(range.from, range.to);

/** The one filter row, sitting above everything it scopes. */
export function UsageRangePicker({
  range,
  onChange,
}: {
  range: UsageRangeEncoded;
  onChange: (range: UsageRangeEncoded) => void;
}) {
  const [open, setOpen] = useState(false);
  // When the custom calendar was opened, null while the presets show: its
  // "today", read at that click rather than on every render.
  const [custom, setCustom] = useState<Date | null>(null);
  const [draft, setDraft] = useState<DateRange | undefined>();

  const close = () => {
    setOpen(false);
    setCustom(null);
    setDraft(undefined);
  };

  const apply = () => {
    const next = draft && toCustomRange(draft);
    if (next) onChange(next);
    close();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) close();
      }}
    >
      <PopoverTrigger
        render={
          <Button variant="outline">
            <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} data-icon="inline-start" />
            {rangeLabel(range)}
          </Button>
        }
      />
      {/* oxlint-disable-next-line shadcn/no-restyle -- holds a menu whose rows carry their own padding and span the full width */}
      <PopoverContent align="end" className={cn(custom ? "w-auto" : "w-56 p-1.5")}>
        {custom ? (
          <div className="flex flex-col gap-3">
            <Calendar
              mode="range"
              numberOfMonths={2}
              selected={draft}
              onSelect={setDraft}
              // Usage cannot exist in the future; offering it invites an
              // empty dashboard with no explanation.
              disabled={{ after: custom }}
              autoFocus
            />
            <div className="flex items-center justify-between gap-3">
              {/* Days run on UTC everywhere else; say so rather than let a
                  user near midnight wonder why a day looks light. */}
              <span className="text-muted-foreground text-xs">{m.analytics_range_utc()}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={close}>
                  {m.common_cancel()}
                </Button>
                {/* react-day-picker fills `from` and `to` on the first click,
                    so this is "nothing picked yet"; one click is a legitimate
                    one-day range and commits as such. */}
                <Button size="sm" onClick={apply} disabled={!draft?.from || !draft.to}>
                  {m.analytics_range_apply()}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {usageRanges().map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => {
                  onChange({ kind: "preset", days: preset.value });
                  close();
                }}
                className={cn(
                  PRESET_ROW,
                  range.kind === "preset" &&
                    range.days === preset.value &&
                    "bg-accent text-accent-foreground",
                )}
              >
                {preset.label}
              </button>
            ))}
            <Separator className="my-1" />
            <button type="button" onClick={() => setCustom(new Date())} className={PRESET_ROW}>
              {m.analytics_range_custom()}
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function StatTile({
  label,
  value,
  sub,
  delta,
  spark,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: string | null;
  spark?: readonly number[];
}) {
  return (
    <Card size="sm" className="min-w-0 gap-1">
      <CardContent className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-muted-foreground text-xs">{label}</span>
        {/* The plot gets its own row below. A value such as “218.8K” plus the
          fixed-width sparkline cannot share a narrow four-column KPI card. */}
        <span className="text-2xl font-semibold tracking-tight whitespace-nowrap tabular-nums">
          {value}
        </span>
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-xs leading-snug">
          {/* Direction is stated, never coloured: more tokens is neither good
            nor bad, and the same tile shape carries cost and error rate. */}
          {delta ? <span className="text-foreground shrink-0 font-medium">{delta}</span> : null}
          {delta && sub ? <span aria-hidden>·</span> : null}
          {sub ? <span className="min-w-0 break-words">{sub}</span> : null}
        </div>
        {spark ? (
          <div className="mt-auto flex h-5.5 w-full min-w-0 justify-end overflow-hidden pt-1">
            <UsageSparkline values={spark} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ChartCard({
  title,
  legend,
  children,
}: {
  title: string;
  legend?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card size="sm" className="gap-3">
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {legend}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

/** Rect swatches (mirroring the bar marks) with the labels in text ink. */
function ChartLegend({ items }: { items: ReadonlyArray<{ label: string; colorVar: string }> }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      {items.map((item) => (
        <span key={item.label} className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span
            aria-hidden
            className="size-2.5 rounded-[3px]"
            style={{ background: `var(${item.colorVar})` }}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

/** A ratio, or null when the denominator is zero, never a fake 0%. */
const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

/**
 * Compare two rates in percentage points.
 * Null unless both sides exist, so an empty prior period shows no delta.
 */
const pointDelta = (current: number | null, previous: number | null): string | null =>
  current === null || previous === null ? null : formatPointDelta(current - previous);

/** Two-segment part-to-whole meter, a static split, so CSS, not a chart. */
// Fixed segment order, so a kind keeps its colour whatever the counts do.
const GENERATION_KINDS = [
  { key: "chat", label: m.analytics_kind_chat, color: "var(--chart-1)" },
  { key: "title", label: m.analytics_kind_title, color: "var(--chart-3)" },
  { key: "compaction", label: m.analytics_kind_summarizing, color: "var(--chart-4)" },
  { key: "review", label: m.analytics_kind_review, color: "var(--chart-5)" },
  { key: "image", label: m.analytics_kind_image, color: "var(--chart-2)" },
] as const;

function SplitMeter({
  counts,
}: {
  counts: Record<(typeof GENERATION_KINDS)[number]["key"], number>;
}) {
  const total = GENERATION_KINDS.reduce((sum, kind) => sum + counts[kind.key], 0);

  return (
    <div className="flex flex-col gap-2">
      <div className="bg-muted flex h-2 gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {GENERATION_KINDS.map((kind) => (
          <div
            key={kind.key}
            style={{
              width: total === 0 ? "0%" : `${(counts[kind.key] / total) * 100}%`,
              background: kind.color,
            }}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-4 text-xs">
        {GENERATION_KINDS.map((kind) => (
          <span key={kind.key} className="flex items-center gap-1.5">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: kind.color }}
              aria-hidden
            />
            <span className="text-foreground font-medium">{formatCount(counts[kind.key])}</span>
            {kind.label()}
            {total > 0 ? ` (${formatPercent(counts[kind.key] / total)})` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** KPI row + the time charts + by-model, shared by admin and settings. */
export function UsageOverview({
  summary,
  previousSummary,
  daily,
  byModel,
  window,
  showActiveUsers,
}: {
  summary: UsageSummary;
  previousSummary: UsageSummary;
  daily: readonly UsageDay[];
  byModel: readonly UsageByModel[];
  /** The window the server actually scanned, ISO-encoded over the wire. */
  window: { from: string; to: string };
  showActiveUsers: boolean;
}) {
  const scanned: UsageWindow = useMemo(
    () => ({ from: new Date(window.from), to: new Date(window.to) }),
    [window.from, window.to],
  );

  const tokens = summary.inputTokens + summary.outputTokens;
  const modelNames = modelLabels(byModel);
  const previousTokens = previousSummary.inputTokens + previousSummary.outputTokens;

  // A partial cost sum is a floor, not a total, so say so instead of lying.
  const costKnown = summary.cost > 0 || summary.costComplete;
  const costValue = costKnown ? formatCost(summary.cost) : "–";
  const costSub =
    !summary.costComplete && summary.cost > 0 ? m.analytics_kpi_cost_partial() : undefined;
  // A delta between two floors is not a delta. Both sides must be complete.
  const bothCostsComplete = summary.costComplete && previousSummary.costComplete;

  const cacheRate = ratio(summary.cachedInputTokens, summary.inputTokens);
  const previousCacheRate = ratio(previousSummary.cachedInputTokens, previousSummary.inputTokens);
  // Errors span chat *and* title runs, so the divisor is attempts, not
  // `messages`, which counts only chat.
  const errorRate = ratio(summary.errorAttempts, summary.attempts);
  const previousErrorRate = ratio(previousSummary.errorAttempts, previousSummary.attempts);

  const series = (pick: (day: UsageDay) => number) => daily.map(pick);

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-3">
        <StatTile
          label={m.analytics_kpi_messages()}
          value={formatCount(summary.messages)}
          delta={formatRelativeDelta(summary.messages, previousSummary.messages)}
          spark={series((day) => day.messages)}
        />
        <StatTile
          label={m.analytics_kpi_tokens()}
          value={formatTokens(tokens)}
          sub={m.analytics_kpi_tokens_split({
            input: formatTokens(summary.inputTokens),
            output: formatTokens(summary.outputTokens),
          })}
          delta={formatRelativeDelta(tokens, previousTokens)}
          spark={series((day) => day.inputTokens + day.outputTokens)}
        />
        <StatTile
          label={m.analytics_kpi_cost()}
          value={costValue}
          {...(costSub ? { sub: costSub } : {})}
          delta={bothCostsComplete ? formatRelativeDelta(summary.cost, previousSummary.cost) : null}
          // Charting a floor as a trend would read as fact.
          {...(summary.costComplete ? { spark: series((day) => day.cost) } : {})}
        />
        <StatTile
          label={m.analytics_kpi_reused()}
          value={cacheRate === null ? "–" : formatPercent(cacheRate)}
          sub={m.analytics_kpi_reused_sub()}
          delta={pointDelta(cacheRate, previousCacheRate)}
        />
        <StatTile
          label={m.analytics_kpi_cost_per_million()}
          value={
            summary.costComplete && tokens > 0 ? formatCostPerMillion(summary.cost, tokens) : "–"
          }
          delta={null}
        />
        <StatTile
          label={m.analytics_kpi_failed()}
          value={errorRate === null ? "–" : formatPercent(errorRate)}
          sub={m.analytics_kpi_failed_sub({
            failed: formatCount(summary.errorAttempts),
            stopped: formatCount(summary.abortedAttempts),
            tries: formatCount(summary.attempts),
            count: summary.attempts,
          })}
          delta={pointDelta(errorRate, previousErrorRate)}
        />
        {showActiveUsers ? (
          <StatTile
            label={m.analytics_kpi_active_users()}
            value={formatCount(summary.activeUsers)}
            delta={formatRelativeDelta(summary.activeUsers, previousSummary.activeUsers)}
          />
        ) : null}
      </div>
      <ChartCard
        title={m.analytics_chart_tokens()}
        legend={
          <ChartLegend
            items={[
              { label: m.analytics_series_input(), colorVar: "--chart-1" },
              { label: m.analytics_series_cached(), colorVar: "--chart-3" },
              { label: m.analytics_series_output(), colorVar: "--chart-2" },
              { label: m.analytics_series_reasoning(), colorVar: "--chart-4" },
            ]}
          />
        }
      >
        <TokensPerDayChart daily={daily} window={scanned} />
        {/* The accessible companion: the stacked segments get small. */}
        <dl className="text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
          {[
            [
              m.analytics_series_input(),
              summary.inputTokens - summary.cachedInputTokens - summary.cacheWriteTokens,
            ],
            [m.analytics_series_cached(), summary.cachedInputTokens],
            [m.analytics_series_cache_write(), summary.cacheWriteTokens],
            [m.analytics_series_output(), summary.outputTokens - summary.reasoningTokens],
            [m.analytics_series_reasoning(), summary.reasoningTokens],
          ].map(([label, value]) => (
            <div key={String(label)} className="flex justify-between gap-2">
              <dt>{label}</dt>
              <dd className="text-foreground tabular-nums">
                {formatTokens(Math.max(Number(value), 0))}
              </dd>
            </div>
          ))}
        </dl>
      </ChartCard>
      <ChartCard title={m.analytics_chart_messages()}>
        <MessagesPerDayChart daily={daily} window={scanned} />
      </ChartCard>
      <ChartCard title={m.analytics_chart_ran()}>
        <SplitMeter
          counts={{
            chat: summary.messages,
            title: summary.titleGenerations,
            compaction: summary.compactionGenerations,
            review: summary.reviewGenerations,
            image: summary.imageGenerations,
          }}
        />
      </ChartCard>
      <ChartCard title={m.analytics_chart_by_model()}>
        <TokensByModelChart byModel={byModel} />
        <UsageTable
          head={[
            m.analytics_table_model(),
            m.analytics_table_messages(),
            m.analytics_table_images(),
            m.analytics_table_tokens(),
            m.analytics_table_cost(),
          ]}
          rows={byModel.map((row, index) => [
            modelNames[index]!,
            formatCount(row.messages),
            row.images > 0 ? formatCount(row.images) : "–",
            formatTokens(row.inputTokens + row.outputTokens),
            groupedCost(row),
          ])}
        />
      </ChartCard>
    </>
  );
}

/** The accessible/complete companion to each chart: plain numbers. */
export function UsageTable({
  head,
  rows,
}: {
  head: readonly string[];
  rows: ReadonlyArray<readonly string[]>;
}) {
  return (
    <Table>
      <TableHeader>
        {/* oxlint-disable-next-line shadcn/no-restyle -- nothing in this table is selectable, so hover would promise an action that is not there */}
        <TableRow className="hover:bg-transparent">
          {head.map((label, i) => (
            <TableHead
              key={label}
              // oxlint-disable-next-line shadcn/no-restyle -- a flush metrics summary, not a data grid
              className={cn("text-muted-foreground h-9 px-0 text-xs", i > 0 && "text-right")}
            >
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((cells, rowIndex) => (
          // Rows are display-only aggregates; index keys are fine.
          // oxlint-disable-next-line no-array-index-key
          <TableRow key={rowIndex}>
            {cells.map((cell, i) => (
              <TableCell
                key={head[i]}
                className={cn(
                  // oxlint-disable-next-line shadcn/no-restyle -- a flush metrics summary, not a data grid
                  "px-0 py-2",
                  i > 0 ? "text-right tabular-nums" : "max-w-48 truncate whitespace-normal",
                )}
              >
                {cell}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const groupedCost = ({ cost, costComplete }: Pick<UsageByModel, "cost" | "costComplete">) =>
  costComplete
    ? formatCost(cost)
    : cost > 0
      ? m.analytics_cost_partial({ cost: formatCost(cost) })
      : m.analytics_cost_unknown();

export function UsersTable({ byUser }: { byUser: readonly UsageByUser[] }) {
  return (
    <UsageTable
      head={[
        m.analytics_table_user(),
        m.analytics_table_messages(),
        m.analytics_table_images(),
        m.analytics_table_tokens(),
        m.analytics_table_cost(),
      ]}
      rows={byUser.map((row) => [
        `${row.name} (${row.email})`,
        formatCount(row.messages),
        row.images > 0 ? formatCount(row.images) : "–",
        formatTokens(row.inputTokens + row.outputTokens),
        groupedCost(row),
      ])}
    />
  );
}
