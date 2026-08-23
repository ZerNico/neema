import type { UsageRange } from "../schema.ts";

/**
 * A resolved half-open window: `from` inclusive, `to` exclusive.
 *
 * Half-open is what makes adjacent windows exact — the previous period ends
 * precisely where this one begins, with no shared instant and no gap, so an
 * event can never be counted in both or neither.
 */
export interface UsageWindow {
  from: Date;
  to: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day `date` falls in. */
const startOfUtcDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

/**
 * Turn a selection into the window the SQL scans.
 *
 * Presets resolve to whole UTC *calendar* days, not rolling 24h multiples:
 * "last 7 days" is the seven UTC buckets ending with today, so `to` is
 * tomorrow's midnight. That matches how `daily` buckets rows and how the
 * charts label them — a rolling start would leave the oldest bucket holding
 * only part of a day while the axis presented it as a whole one.
 */
export const resolveUsageWindow = (range: UsageRange, now: Date): UsageWindow => {
  if (range.kind === "custom") return { from: range.from, to: range.to };
  const to = new Date(startOfUtcDay(now).getTime() + DAY_MS);
  return { from: new Date(to.getTime() - range.days * DAY_MS), to };
};

/** The equal-length window immediately before this one — the delta baseline. */
export const previousUsageWindow = (window: UsageWindow): UsageWindow => {
  const span = window.to.getTime() - window.from.getTime();
  return { from: new Date(window.from.getTime() - span), to: new Date(window.from) };
};

/**
 * Every UTC day key the window covers, oldest first.
 *
 * Charts densify against this rather than counting back from today, so a
 * custom window that ended months ago still renders its own days.
 */
export const windowDays = (window: UsageWindow): string[] => {
  const out: string[] = [];
  const end = window.to.getTime();
  for (let t = startOfUtcDay(window.from).getTime(); t < end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};
