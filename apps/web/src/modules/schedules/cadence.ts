/**
 * The picker's view of a cron expression. The cron stays the stored truth;
 * this recognizes the shapes the picker can offer and falls back to `cron`
 * for everything else, so a model-authored expression is never rewritten.
 *
 * "Every N" exists only where cron repeats evenly: hour steps that divide a
 * day and month steps that divide a year. Every N days, weeks or years has
 * no exact cron form, so the picker does not offer it.
 */
export interface ClockTime {
  readonly hour: number;
  readonly minute: number;
}

export type Cadence =
  | { readonly kind: "hourly"; readonly every: number; readonly minute: number }
  | { readonly kind: "daily"; readonly time: ClockTime }
  | { readonly kind: "weekdays"; readonly time: ClockTime }
  /** Days are cron weekdays, 0 = Sunday. */
  | { readonly kind: "weekly"; readonly days: ReadonlyArray<number>; readonly time: ClockTime }
  | {
      readonly kind: "monthly";
      readonly every: number;
      readonly days: ReadonlyArray<number>;
      readonly time: ClockTime;
    }
  | {
      readonly kind: "yearly";
      /** 1 = January. */
      readonly month: number;
      readonly days: ReadonlyArray<number>;
      readonly time: ClockTime;
    }
  | { readonly kind: "cron"; readonly cron: string };

export type CadenceKind = Cadence["kind"];

export const HOUR_STEPS: ReadonlyArray<number> = [1, 2, 3, 4, 6, 8, 12];
export const MONTH_STEPS: ReadonlyArray<number> = [1, 2, 3, 4, 6];

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const WORKWEEK = [1, 2, 3, 4, 5];

/** Stands for cron's `L`, the last day of each month; sorts after the 31st. */
export const LAST_DAY = 32;

const integer = (value: string, min: number, max: number): number | null => {
  if (!/^\d{1,2}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : null;
};

/** A comma list of integers in range, deduplicated in ascending order; null otherwise. */
const intList = (value: string, min: number, max: number): number[] | null => {
  const parts = value.split(",").map((part) => integer(part, min, max));
  if (parts.some((part) => part === null)) return null;
  const seen = new Set(parts);
  return Array.from({ length: max - min + 1 }, (_, index) => index + min).filter((n) =>
    seen.has(n),
  );
};

/** `*` is 1, `*` over N is N when N is an allowed step, anything else is null. */
const step = (value: string, allowed: ReadonlyArray<number>): number | null => {
  if (value === "*") return 1;
  const match = /^\*\/(\d{1,2})$/.exec(value);
  const every = match ? Number(match[1]) : null;
  return every !== null && every > 1 && allowed.includes(every) ? every : null;
};

/** Days of the month, where `L` is the last day; null for anything else. */
const monthDayList = (value: string): number[] | null => {
  const tokens = value.split(",");
  const numbered = tokens.filter((token) => token !== "L");
  const days = numbered.length > 0 ? intList(numbered.join(","), 1, 31) : [];
  if (!days) return null;
  return tokens.includes("L") ? [...days, LAST_DAY] : days;
};

/** Ascending and deduplicated; pickers report days in click order. */
export const inOrder = (days: ReadonlyArray<number>): number[] => {
  const picked = new Set(days);
  return Array.from({ length: LAST_DAY + 1 }, (_, day) => day).filter((day) => picked.has(day));
};

const sameDays = (a: ReadonlyArray<number>, b: ReadonlyArray<number>) =>
  a.length === b.length && a.every((day, index) => day === b[index]);

export function parseCadence(cron: string): Cadence {
  const trimmed = cron.trim();
  const fallback = { kind: "cron", cron: trimmed } as const;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return fallback;
  const [minuteField, hourField, dayField, monthField, weekdayField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = integer(minuteField, 0, 59);
  if (minute === null) return fallback;

  const hourEvery = step(hourField, HOUR_STEPS);
  if (hourEvery !== null)
    return dayField === "*" && monthField === "*" && weekdayField === "*"
      ? { kind: "hourly", every: hourEvery, minute }
      : fallback;

  const hour = integer(hourField, 0, 23);
  if (hour === null) return fallback;
  const time = { hour, minute };

  if (dayField === "*") {
    if (monthField !== "*") return fallback;
    if (weekdayField === "*") return { kind: "daily", time };
    if (weekdayField === "1-5") return { kind: "weekdays", time };
    // Cron accepts 7 for Sunday too; 0 stands for both.
    const listed = intList(weekdayField, 0, 7);
    if (!listed) return fallback;
    const days = intList(listed.map((day) => (day === 7 ? 0 : day)).join(","), 0, 6)!;
    return sameDays(days, WORKWEEK) ? { kind: "weekdays", time } : { kind: "weekly", days, time };
  }

  const days = monthDayList(dayField);
  if (!days || weekdayField !== "*") return fallback;
  const monthEvery = step(monthField, MONTH_STEPS);
  if (monthEvery !== null) return { kind: "monthly", every: monthEvery, days, time };
  const month = integer(monthField, 1, 12);
  return month === null ? fallback : { kind: "yearly", month, days, time };
}

const everyField = (every: number) => (every === 1 ? "*" : `*/${every}`);

const daysField = (days: ReadonlyArray<number>) =>
  days.map((day) => (day === LAST_DAY ? "L" : day)).join(",");

export function cadenceCron(cadence: Cadence): string {
  if (cadence.kind === "cron") return cadence.cron;
  if (cadence.kind === "hourly") return `${cadence.minute} ${everyField(cadence.every)} * * *`;
  const { minute, hour } = cadence.time;
  switch (cadence.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${sameDays(cadence.days, WORKWEEK) ? "1-5" : cadence.days.join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${daysField(cadence.days)} ${everyField(cadence.every)} *`;
    case "yearly":
      return `${minute} ${hour} ${daysField(cadence.days)} ${cadence.month} *`;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

export const clockText = (time: ClockTime) => `${pad(time.hour)}:${pad(time.minute)}`;

export const ordinal = (day: number) => {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
};

const list = new Intl.ListFormat("en", { type: "conjunction" });

export const weekdaysText = (days: ReadonlyArray<number>) =>
  list.format(days.map((day) => WEEKDAY_NAMES[day]!));

export const monthDayText = (day: number) => (day === LAST_DAY ? "last day" : ordinal(day));

export const monthDaysText = (days: ReadonlyArray<number>) => list.format(days.map(monthDayText));

/**
 * The stored `scheduleText` for a picked cadence; null for a raw cron, which
 * keeps its own. `compact` counts long day lists instead of naming them, for
 * one-line places like the schedule list.
 */
export function cadenceText(cadence: Cadence, compact = false): string | null {
  const weekdays = (days: ReadonlyArray<number>) =>
    compact && days.length > 3 ? `${days.length} days a week` : weekdaysText(days);
  const monthDays = (days: ReadonlyArray<number>) =>
    compact && days.length > 3 ? `${days.length} days` : `the ${monthDaysText(days)}`;
  if (cadence.kind === "cron") return null;
  if (cadence.kind === "hourly") {
    const every = cadence.every === 1 ? "Every hour" : `Every ${cadence.every} hours`;
    return cadence.minute === 0 ? every : `${every} at :${pad(cadence.minute)}`;
  }
  const at = `at ${clockText(cadence.time)}`;
  switch (cadence.kind) {
    case "daily":
      return `Every day ${at}`;
    case "weekdays":
      return `Every weekday ${at}`;
    case "weekly":
      return sameDays(cadence.days, WORKWEEK)
        ? `Every weekday ${at}`
        : compact && cadence.days.length > 3
          ? `${weekdays(cadence.days)} ${at}`
          : `Every ${weekdays(cadence.days)} ${at}`;
    case "monthly": {
      const every = cadence.every === 1 ? "Every month" : `Every ${cadence.every} months`;
      return `${every} on ${monthDays(cadence.days)} ${at}`;
    }
    case "yearly":
      return `Every ${MONTH_NAMES[cadence.month - 1]} on ${monthDays(cadence.days)} ${at}`;
  }
}

/** Whether the one-line preset row can show this, rather than the Custom card. */
export function isPreset(cadence: Cadence): boolean {
  switch (cadence.kind) {
    case "hourly":
      return cadence.every === 1;
    case "daily":
    case "weekdays":
      return true;
    case "weekly":
      return cadence.days.length === 1;
    case "monthly":
      return cadence.every === 1 && cadence.days.length === 1;
    case "yearly":
    case "cron":
      return false;
  }
}

const timeOf = (cadence: Cadence): ClockTime =>
  "time" in cadence
    ? cadence.time
    : { hour: 9, minute: cadence.kind === "hourly" ? cadence.minute : 0 };

const monthDaysOf = (cadence: Cadence) =>
  cadence.kind === "monthly" || cadence.kind === "yearly" ? cadence.days : [1];

const weekdaysOf = (cadence: Cadence) =>
  cadence.kind === "weekly" ? cadence.days : cadence.kind === "weekdays" ? WORKWEEK : [1];

/**
 * Switching kinds keeps what still applies (the time, the chosen days), so
 * moving through the menu never resets what was set. `single` trims to what
 * the one-line presets can show.
 */
export function withKind(
  cadence: Cadence,
  kind: Exclude<CadenceKind, "cron">,
  single = false,
): Cadence {
  const time = timeOf(cadence);
  const keepEvery = (from: CadenceKind) =>
    !single && cadence.kind === from && "every" in cadence ? cadence.every : 1;
  const trim = (days: ReadonlyArray<number>) => (single ? days.slice(0, 1) : days);
  switch (kind) {
    case "hourly":
      return { kind, every: keepEvery("hourly"), minute: time.minute };
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, days: trim(weekdaysOf(cadence)), time };
    case "monthly":
      return { kind, every: keepEvery("monthly"), days: trim(monthDaysOf(cadence)), time };
    case "yearly":
      return {
        kind,
        month: cadence.kind === "yearly" ? cadence.month : 1,
        days: monthDaysOf(cadence),
        time,
      };
  }
}

export const DEFAULT_CADENCE: Cadence = { kind: "daily", time: { hour: 9, minute: 0 } };
