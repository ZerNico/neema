// Local-clock labels for the message list and the sidebar. Every function here
// reads the visitor's timezone and clock, which the app always has: routes
// render only in the browser, below the root shell's client-only boundary.

import type { DatedConversation } from "./conversation-groups.ts";

interface Formatters {
  readonly clock: Intl.DateTimeFormat;
  readonly weekday: Intl.DateTimeFormat;
  readonly dayMonth: Intl.DateTimeFormat;
  readonly dayMonthYear: Intl.DateTimeFormat;
  readonly full: Intl.DateTimeFormat;
  readonly relative: Intl.RelativeTimeFormat;
}

// Constructing an Intl.DateTimeFormat is the expensive part; a chat can hold
// hundreds of messages and each render formats every one of them.
const cache = new Map<string, Formatters>();

const formatters = (locale?: string): Formatters => {
  const cached = cache.get(locale ?? "");
  if (cached) return cached;
  const made: Formatters = {
    // "numeric" hour, so a 12-hour locale says "2:32 PM" rather than "02:32 PM".
    clock: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }),
    weekday: new Intl.DateTimeFormat(locale, { weekday: "long" }),
    dayMonth: new Intl.DateTimeFormat(locale, { day: "numeric", month: "long" }),
    dayMonthYear: new Intl.DateTimeFormat(locale, {
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    full: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short" }),
    relative: new Intl.RelativeTimeFormat(locale, { numeric: "auto" }),
  };
  cache.set(locale ?? "", made);
  return made;
};

// ICU separates the time from AM/PM with U+202F and uses U+00A0 in several
// locales. Both copy badly out of the page and read identically as a space.
const normalize = (text: string): string => text.replaceAll(/[\u202F\u00A0]/g, " ");

const DAY_MS = 86_400_000;

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// Rounded, so the hour a DST switch adds or removes between two midnights
// cannot shift a day across a boundary.
const daysBefore = (day: number, today: number): number => Math.round((today - day) / DAY_MS);

/**
 * Heading for a calendar day: "Today", "Yesterday", the weekday within the
 * past week, then the date itself, with the year only once it stops being
 * implied by the current one.
 */
export function dayLabel(date: Date, now: Date = new Date(), locale?: string): string {
  const diff = daysBefore(startOfDay(date), startOfDay(now));
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  const format = formatters(locale);
  // Stops at 6: seven days ago is the same weekday as today, which reads as
  // the wrong week rather than as a date.
  if (diff < 7) return normalize(format.weekday.format(date));
  if (date.getFullYear() === now.getFullYear()) return normalize(format.dayMonth.format(date));
  return normalize(format.dayMonthYear.format(date));
}

/** Short local clock time, e.g. "14:32" or "2:32 PM". */
export const clockLabel = (date: Date, locale?: string): string =>
  normalize(formatters(locale).clock.format(date));

/** Unabbreviated weekday, date and time, for tooltips. */
export const absoluteLabel = (date: Date, locale?: string): string =>
  normalize(formatters(locale).full.format(date));

export interface MessageTime {
  /** Machine-readable value for the `<time>` element. */
  readonly iso: string;
  /** Short local clock time shown in the message's action row. */
  readonly clock: string;
  /** Full date and time, plus the edit time when there is one. */
  readonly absolute: string;
}

export interface MessageStamp extends MessageTime {
  /** Heading for the day this message opens; null when it continues one. */
  readonly dayLabel: string | null;
}

export interface StampedMessage {
  readonly id: string;
  readonly createdAt: Date | string | number;
  readonly editedAt?: Date | string | number | null;
}

/**
 * Stamps for an ordered run of messages. Day headings are computed against the
 * message before them, so this must be given the list as rendered. Filtering
 * afterwards would leave a day opening with no heading.
 */
export function buildMessageStamps(
  messages: ReadonlyArray<StampedMessage>,
  now: Date = new Date(),
  locale?: string,
): ReadonlyMap<string, MessageStamp> {
  const stamps = new Map<string, MessageStamp>();
  let previousDay: number | null = null;
  for (const message of messages) {
    const date = new Date(message.createdAt);
    // A row with an unreadable timestamp still has to render. It just goes
    // without a stamp rather than heading its day "Invalid Date".
    if (Number.isNaN(date.getTime())) continue;
    const day = startOfDay(date);
    const edited = optionalDate(message.editedAt);
    stamps.set(message.id, {
      dayLabel: day === previousDay ? null : dayLabel(date, now, locale),
      iso: date.toISOString(),
      clock: clockLabel(date, locale),
      absolute: edited
        ? `${absoluteLabel(date, locale)} · edited ${absoluteLabel(edited, locale)}`
        : absoluteLabel(date, locale),
    });
    previousDay = day;
  }
  return stamps;
}

const optionalDate = (value: Date | string | number | null | undefined): Date | null => {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Compact relative age for sidebar previews, e.g. "12 minutes ago". */
export function relativeAgeLabel(
  value: Date | string | number,
  now: Date = new Date(),
  locale?: string,
): string {
  const date = optionalDate(value);
  if (!date) return "";

  const seconds = (date.getTime() - now.getTime()) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  if (absoluteSeconds < 60) return "just now";

  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] =
    absoluteSeconds < 3_600
      ? [seconds / 60, "minute"]
      : absoluteSeconds < DAY_MS / 1_000
        ? [seconds / 3_600, "hour"]
        : absoluteSeconds < 30 * (DAY_MS / 1_000)
          ? [seconds / (DAY_MS / 1_000), "day"]
          : absoluteSeconds < 365 * (DAY_MS / 1_000)
            ? [seconds / (30 * (DAY_MS / 1_000)), "month"]
            : [seconds / (365 * (DAY_MS / 1_000)), "year"];

  return normalize(formatters(locale).relative.format(Math.round(amount), unit));
}

/** Sidebar row tooltip: when the chat was last active, in full. */
export function describeActivity(conversation: DatedConversation, locale?: string): string {
  const last = optionalDate(conversation.lastMessageAt);
  if (last) return `Last message ${absoluteLabel(last, locale)}`;
  const created = optionalDate(conversation.createdAt);
  return created ? `Created ${absoluteLabel(created, locale)}` : "";
}

/**
 * Compact visible stamp for a conversation row: the clock time while it is
 * still today, the day label after that. Empty when there is no usable date.
 */
export function activityStamp(
  conversation: DatedConversation,
  now: Date = new Date(),
  locale?: string,
): string {
  const date = optionalDate(conversation.lastMessageAt) ?? optionalDate(conversation.createdAt);
  if (!date) return "";
  const label = dayLabel(date, now, locale);
  return label === "Today" ? clockLabel(date, locale) : label;
}
