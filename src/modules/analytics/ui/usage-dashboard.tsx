import type { ReactNode } from "react";
import type { UsageByModel, UsageByUser, UsageDay, UsageSummary } from "../server/repo.ts";
import type { UsageRangeDays } from "../schema.ts";
import { MessagesPerDayChart, TokensByModelChart, TokensPerDayChart } from "./charts.tsx";
import { formatCost, formatCount, formatTokens } from "./format.ts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";

export const USAGE_RANGES: Array<{ value: UsageRangeDays; label: string }> = [
  { value: 7, label: "Last 7 days" },
  { value: 30, label: "Last 30 days" },
  { value: 90, label: "Last 90 days" },
];

/** The one filter row — sits above everything it scopes. */
export function UsageRangeSelect({
  days,
  onChange,
}: {
  days: UsageRangeDays;
  onChange: (days: UsageRangeDays) => void;
}) {
  return (
    <Select
      value={String(days)}
      onValueChange={(v) => v && onChange(Number(v) as UsageRangeDays)}
      items={USAGE_RANGES.map((r) => ({ value: String(r.value), label: r.label }))}
    >
      <SelectTrigger className="w-40" aria-label="Date range">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {USAGE_RANGES.map((r) => (
          <SelectItem key={r.value} value={String(r.value)}>
            {r.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border-border bg-background flex flex-col gap-1 rounded-lg border px-4 py-3">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="text-2xl font-semibold tracking-tight">{value}</span>
      {sub ? <span className="text-muted-foreground text-xs">{sub}</span> : null}
    </div>
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
    <section className="border-border bg-background flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {legend}
      </div>
      {children}
    </section>
  );
}

/** Rect swatches (mirroring the bar marks) with the labels in text ink. */
function ChartLegend({ items }: { items: ReadonlyArray<{ label: string; colorVar: string }> }) {
  return (
    <div className="flex items-center gap-4">
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

/** KPI row + the two time charts + by-model — shared by admin and settings. */
export function UsageOverview({
  summary,
  daily,
  byModel,
  days,
  showActiveUsers,
}: {
  summary: UsageSummary;
  daily: readonly UsageDay[];
  byModel: readonly UsageByModel[];
  days: UsageRangeDays;
  showActiveUsers: boolean;
}) {
  // A partial cost sum is a floor, not a total — say so instead of lying.
  const costValue = summary.cost > 0 || summary.costComplete ? formatCost(summary.cost) : "—";
  const costSub =
    !summary.costComplete && summary.cost > 0 ? "at least — some costs unknown" : undefined;

  return (
    <>
      <div
        className={`grid grid-cols-2 gap-3 ${showActiveUsers ? "md:grid-cols-4" : "md:grid-cols-3"}`}
      >
        <StatTile label="Messages" value={formatCount(summary.messages)} />
        <StatTile
          label="Tokens"
          value={formatTokens(summary.inputTokens + summary.outputTokens)}
          sub={`${formatTokens(summary.inputTokens)} in / ${formatTokens(summary.outputTokens)} out`}
        />
        <StatTile label="Cost" value={costValue} {...(costSub ? { sub: costSub } : {})} />
        {showActiveUsers ? (
          <StatTile label="Active users" value={formatCount(summary.activeUsers)} />
        ) : null}
      </div>
      <ChartCard
        title="Tokens per day"
        legend={
          <ChartLegend
            items={[
              { label: "Input", colorVar: "--chart-1" },
              { label: "Output", colorVar: "--chart-2" },
            ]}
          />
        }
      >
        <TokensPerDayChart daily={daily} days={days} />
      </ChartCard>
      <ChartCard title="Messages per day">
        <MessagesPerDayChart daily={daily} days={days} />
      </ChartCard>
      <ChartCard title="By model">
        <TokensByModelChart byModel={byModel} />
        <UsageTable
          head={["Model", "Messages", "Tokens", "Cost"]}
          rows={byModel.map((row) => [
            row.modelName,
            formatCount(row.messages),
            formatTokens(row.inputTokens + row.outputTokens),
            row.cost > 0 ? formatCost(row.cost) : "—",
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
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-border border-b text-left text-xs">
            {head.map((label, i) => (
              <th key={label} className={`py-2 font-medium ${i > 0 ? "text-right" : ""}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            // Rows are display-only aggregates; index keys are fine.
            // oxlint-disable-next-line no-array-index-key
            <tr key={rowIndex} className="border-border border-b last:border-0">
              {cells.map((cell, i) => (
                // oxlint-disable-next-line no-array-index-key
                <td
                  key={i}
                  className={`py-2 ${i > 0 ? "text-right tabular-nums" : "max-w-48 truncate"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UsersTable({ byUser }: { byUser: readonly UsageByUser[] }) {
  return (
    <UsageTable
      head={["User", "Messages", "Tokens", "Cost"]}
      rows={byUser.map((row) => [
        `${row.name} (${row.email})`,
        formatCount(row.messages),
        formatTokens(row.inputTokens + row.outputTokens),
        row.cost > 0 ? formatCost(row.cost) : "—",
      ])}
    />
  );
}
