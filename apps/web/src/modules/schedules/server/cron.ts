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

/**
 * Every fire starts a conversation and a model call, and the tick runs twice a
 * minute, so a denser cron would spend without bound. The picker's finest
 * option is hourly; this holds the model and the API to the same floor.
 */
export const MIN_FIRE_GAP_MS = 60 * 60 * 1000;
const GAP_SAMPLE = 48;

/** Null when valid; a short reason otherwise, safe to hand back to a model. */
export const validateCron = (cron: string, timezone: string): string | null => {
  // croner also takes a leading seconds field, which would fire every tick.
  if (cron.trim().split(/\s+/).length !== 5)
    return "use a 5-field cron expression (minute hour day month weekday)";
  try {
    const instance = make(cron, timezone);
    if (!instance.nextRun(new Date(0)) && !hasFarFutureRun(cron, timezone))
      return "this expression never fires";
    if (firesTooOften(instance)) return "a schedule can run at most once an hour";
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 200) : "invalid cron expression";
  }
};

const firesTooOften = (instance: Cron) => {
  let previous = instance.nextRun();
  for (let index = 0; previous && index < GAP_SAMPLE; index += 1) {
    const next = instance.nextRun(previous);
    if (!next) return false;
    if (next.getTime() - previous.getTime() < MIN_FIRE_GAP_MS) return true;
    previous = next;
  }
  return false;
};

// croner reports a never-firing expression (e.g. Feb 30) as no next run; probe
// with a second start far ahead so "valid but not soon" is not misread.
const hasFarFutureRun = (cron: string, timezone: string) =>
  make(cron, timezone).nextRun(new Date("2030-01-01T00:00:00Z")) !== null;

/**
 * Why a cadence cannot be saved, or null: the zone first, since croner throws
 * its own message for one it does not know.
 */
export const cadenceIssue = (cadence: {
  cron: string;
  timezone: string;
  endAt?: string | null | undefined;
}): string | null => {
  if (!isValidTimezone(cadence.timezone)) return "unknown timezone";
  const cronIssue = validateCron(cadence.cron, cadence.timezone);
  if (cronIssue) return `invalid schedule: ${cronIssue}`;
  if (cadence.endAt && Number.isNaN(new Date(cadence.endAt).getTime())) return "invalid end time";
  return null;
};

export const isValidTimezone = (timezone: string): boolean => {
  try {
    // oxlint-disable-next-line no-new -- constructing it is the validation: an unknown zone throws
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
