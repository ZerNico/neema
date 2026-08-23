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

/** The last `days` UTC day keys ending today, oldest first. */
export const lastDays = (days: number): string[] => {
  const out: string[] = [];
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(now - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  }
  return out;
};
