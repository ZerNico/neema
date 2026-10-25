// Shared number formatting so tiles, tooltips, axes and tables agree. Each call reads the
// locale, since a module-level formatter would be fixed to whichever request loaded it.
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

/** 1234 → "1.2K", 5_600_000 → "5.6M". */
export const formatTokens = (value: number): string =>
  new Intl.NumberFormat(getLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );

export const formatCount = (value: number): string =>
  new Intl.NumberFormat(getLocale()).format(value);

/**
 * Costs span cents to hundreds of dollars; three significant digits keep tiny
 * per-message numbers readable without turning totals into noise.
 */
export const formatCost = (value: number): string =>
  new Intl.NumberFormat(getLocale(), {
    style: "currency",
    currency: "USD",
    maximumSignificantDigits: 3,
  }).format(value);

/** "2026-08-12" → "Aug 12" for axis ticks and tooltips. */
export const formatDay = (day: string): string =>
  new Intl.DateTimeFormat(getLocale(), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/** 0.42 → "42%". Rates are coarse; a decimal place would imply precision. */
export const formatPercent = (value: number): string =>
  new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(value);

/**
 * Ratios that are already percentages move in *points*, not percent: 1% → 2%
 * is +1pp, and calling that "+100%" would be true but wildly misleading.
 */
export const formatPointDelta = (delta: number): string =>
  m.analytics_point_delta({
    sign: delta >= 0 ? "+" : "−",
    value: new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(Math.abs(delta * 100)),
  });

/**
 * Relative change for counts and totals. Null means there is no honest
 * comparison to draw, so the caller renders nothing rather than a fake 0%.
 */
export const formatRelativeDelta = (current: number, previous: number): string | null => {
  if (previous === 0) return current === 0 ? null : m.analytics_delta_new();
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return formatPercent(0);
  return `${change >= 0 ? "+" : "−"}${formatPercent(Math.abs(change))}`;
};

/** Cost per million tokens, the blended rate across every model in range. */
export const formatCostPerMillion = (cost: number, tokens: number): string =>
  m.analytics_cost_per_million({ cost: formatCost((cost / tokens) * 1_000_000) });

/** "Aug 10 – Aug 15, 2026" for the picker trigger; `to` is exclusive. */
export const formatRangeLabel = (from: string, to: string): string => {
  const start = new Date(from);
  // The window ends at midnight *after* the last day the user picked.
  const end = new Date(new Date(to).getTime() - 24 * 60 * 60 * 1000);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- day is a one-line helper read where it is used
  const day = (date: Date) => formatDay(date.toISOString().slice(0, 10));
  const range =
    day(start) === day(end)
      ? day(start)
      : m.analytics_range_span({ start: day(start), end: day(end) });
  const year = String(end.getUTCFullYear());
  return sameYear
    ? m.analytics_range_same_year({ range, year })
    : m.analytics_range_other_year({ range, year });
};
