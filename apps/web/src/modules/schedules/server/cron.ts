import { Cron } from "croner";

/**
 * The only place croner is constructed, so the library stays swappable.
 * A schedule's cron is interpreted in its IANA timezone; DST gaps and repeats
 * are the library's documented behavior, not something we re-derive.
 */

const make = (cron: string, timezone: string) =>
  new Cron(cron, { timezone, paused: true, protect: false });

/** Null = the expression parses but never fires within the search horizon. */
export const nextFireAt = (cron: string, timezone: string, from: Date): Date | null =>
  make(cron, timezone).nextRun(from);

/** Null when valid; a short reason otherwise, safe to hand back to a model. */
export const validateCron = (cron: string, timezone: string): string | null => {
  try {
    const instance = make(cron, timezone);
    if (!instance.nextRun(new Date(0)) && !hasFarFutureRun(cron, timezone))
      return "this expression never fires";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : "invalid cron expression";
  }
};

// croner reports a never-firing expression (e.g. Feb 30) as no next run; probe
// with a second start far ahead so "valid but not soon" is not misread.
const hasFarFutureRun = (cron: string, timezone: string) =>
  make(cron, timezone).nextRun(new Date("2030-01-01T00:00:00Z")) !== null;

export const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

export const previewFires = (
  cron: string,
  timezone: string,
  count: number,
  from: Date = new Date(),
  endAt?: Date | null,
): Date[] => {
  const instance = make(cron, timezone);
  const fires: Date[] = [];
  let cursor: Date | null = from;
  while (fires.length < count) {
    cursor = instance.nextRun(cursor);
    if (!cursor || (endAt && cursor > endAt)) break;
    fires.push(cursor);
  }
  return fires;
};
