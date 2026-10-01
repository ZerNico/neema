/**
 * Excel's 1900 date system: serial 1 is 1 January 1900, and serial 60 is
 * 29 February 1900, a day that never existed but that Excel keeps for Lotus
 * compatibility. Every serial from 61 on is one past the real day count.
 */
const MS_PER_DAY = 86_400_000;
const EPOCH = Date.UTC(1899, 11, 31);
/** 31 December 9999, the last day Excel shows. */
export const MAX_SERIAL = 2_958_465;

/** The serial of a calendar date, rolling months and days over as DATE does, or null out of range. */
export function serialOf(year: number, month: number, day: number): number | null {
  let y = Math.trunc(year);
  if (y >= 0 && y < 1900) y += 1900;
  const m = Math.trunc(month) - 1;
  y += Math.floor(m / 12);
  const monthIndex = ((m % 12) + 12) % 12;
  if (y < 1900 || y > 9999) return null;
  let first = (Date.UTC(y, monthIndex, 1) - EPOCH) / MS_PER_DAY;
  if (y > 1900 || monthIndex >= 2) first += 1;
  const serial = first + Math.trunc(day) - 1;
  return serial < 0 || serial > MAX_SERIAL ? null : serial;
}

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}
/** The calendar date of a serial's whole part, or null out of range. */
export function partsOf(serial: number): DateParts | null {
  const whole = Math.floor(serial);
  if (whole < 0 || whole > MAX_SERIAL) return null;
  if (whole === 0) return { year: 1900, month: 1, day: 0 };
  if (whole === 60) return { year: 1900, month: 2, day: 29 };
  const date = new Date(EPOCH + (whole > 60 ? whole - 1 : whole) * MS_PER_DAY);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Sunday is 0; Excel's serial 1 is a Sunday by its own (leap-day) count. */
export const weekdayOf = (serial: number) => (Math.floor(serial) + 6) % 7;

/** Hours, minutes and seconds of a serial's fraction, to the nearest second. */
export function clockOf(serial: number) {
  const seconds = Math.round((serial - Math.floor(serial)) * 86_400);
  return {
    hour: Math.floor(seconds / 3600) % 24,
    minute: Math.floor(seconds / 60) % 60,
    second: seconds % 60,
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const monthNamed = (name: string) => {
  const lower = name.toLowerCase().replace(/\.$/, "");
  const index = MONTHS.findIndex((month) => lower.startsWith(month));
  const full = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(2000, index, 1)))
    .toLowerCase();
  // "Sept" is accepted; any other spelling has to be a prefix of the month's name.
  return index >= 0 && (full.startsWith(lower) || lower === "sept") ? index + 1 : null;
};

const TIME = String.raw`(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?\s*(am|pm|a|p)?`;
const timeOnly = new RegExp(`^${TIME}$`, "i");

function clockText(text: string): number | null {
  const match = timeOnly.exec(text.trim());
  if (!match || (match[2] === undefined && !match[4])) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const second = Number(match[3] ?? 0);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.startsWith("p") ? 12 : 0);
  }
  if (minute > 59 || second >= 60) return null;
  // Past 24 hours only without a meridiem, as in "25:00".
  if (hour > 9999) return null;
  return (hour * 3600 + minute * 60 + second) / 86_400;
}

const twoDigitYear = (text: string) => {
  const year = Number(text);
  return text.length <= 2 ? (year < 30 ? 2000 + year : 1900 + year) : year;
};

function validDate(year: number, month: number, day: number) {
  if (month < 1 || month > 12 || day < 1) return null;
  if (year === 1900 && month === 2 && day === 29) return 60;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day > days ? null : serialOf(year, month, day);
}

function calendarText(text: string): number | null {
  let match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})$/.exec(text);
  if (match) return validDate(twoDigitYear(match[3]!), Number(match[1]), Number(match[2]));
  match = /^(\d{1,2})[-\s]+([a-z]+\.?)[-\s,]+(\d{2}|\d{4})$/i.exec(text);
  if (match) {
    const month = monthNamed(match[2]!);
    return month ? validDate(twoDigitYear(match[3]!), month, Number(match[1])) : null;
  }
  match = /^([a-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text);
  if (match) {
    const month = monthNamed(match[1]!);
    return month ? validDate(Number(match[3]), month, Number(match[2])) : null;
  }
  match = /^([a-z]+\.?)[-\s]+(\d{4})$/i.exec(text);
  if (match) {
    const month = monthNamed(match[1]!);
    return month ? validDate(Number(match[2]), month, 1) : null;
  }
  return null;
}

/**
 * A date, a time or both as US-English Excel reads typed text, as a serial,
 * or null. A date needs its year: "1/15" would mean the current year, which
 * a stored result can't depend on.
 */
export function parseDateText(raw: string): number | null {
  const text = raw.trim().replace(/\s+/g, " ");
  if (!/[\d]/.test(text)) return null;
  const time = clockText(text);
  if (time !== null) return time;
  const date = calendarText(text);
  if (date !== null) return date;
  // A date followed by a time: split at the last space before the time's digits.
  const split = /^(.*?)[ T](\d{1,2}(?::\d{1,2}){0,2}(?:\.\d+)?\s*(?:am|pm|a|p)?)$/i.exec(text);
  if (!split) return null;
  const day = calendarText(split[1]!.trim());
  const clock = clockText(split[2]!);
  return day === null || clock === null ? null : day + clock;
}
