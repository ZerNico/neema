// Shared number formatting so tiles, tooltips, axes and tables agree.

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const plain = new Intl.NumberFormat("en-US");

/** 1234 → "1.2K", 5_600_000 → "5.6M". */
export const formatTokens = (value: number): string => compact.format(value);

export const formatCount = (value: number): string => plain.format(value);

/**
 * Costs span cents to hundreds of dollars; three significant digits keep tiny
 * per-message numbers readable without turning totals into noise.
 */
export const formatCost = (value: number): string =>
  `$${value.toLocaleString("en-US", { maximumSignificantDigits: 3 })}`;

/** "2026-08-12" → "Aug 12" for axis ticks and tooltips. */
export const formatDay = (day: string): string => {
  const [, month, dayOfMonth] = day.split("-");
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${names[Number(month) - 1]} ${Number(dayOfMonth)}`;
};

/** 0.42 → "42%". Rates are coarse; a decimal place would imply precision. */
export const formatPercent = (value: number): string => `${Math.round(value * 100)}%`;

/**
 * Ratios that are already percentages move in *points*, not percent: 1% → 2%
 * is +1pp, and calling that "+100%" would be true but wildly misleading.
 */
export const formatPointDelta = (delta: number): string =>
  `${delta >= 0 ? "+" : "\u2212"}${Math.abs(delta * 100).toFixed(1)}pp`;

/**
 * Relative change for counts and totals. Null means there is no honest
 * comparison to draw, so the caller renders nothing rather than a fake 0%.
 */
export const formatRelativeDelta = (current: number, previous: number): string | null => {
  if (previous === 0) return current === 0 ? null : "New";
  const change = (current - previous) / previous;
  if (Math.abs(change) < 0.005) return "0%";
  return `${change >= 0 ? "+" : "\u2212"}${Math.abs(change * 100).toFixed(0)}%`;
};

/** Cost per million tokens, the blended rate across every model in range. */
export const formatCostPerMillion = (cost: number, tokens: number): string =>
  `${formatCost((cost / tokens) * 1_000_000)}/M`;

/** "Aug 10 – Aug 15, 2026" for the picker trigger; `to` is exclusive. */
export const formatRangeLabel = (from: string, to: string): string => {
  const start = new Date(from);
  // The window ends at midnight *after* the last day the user picked.
  const end = new Date(new Date(to).getTime() - 24 * 60 * 60 * 1000);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const day = (date: Date) => formatDay(date.toISOString().slice(0, 10));
  const label = day(start) === day(end) ? day(start) : `${day(start)} \u2013 ${day(end)}`;
  return sameYear ? `${label}, ${end.getUTCFullYear()}` : `${label} ${end.getUTCFullYear()}`;
};
