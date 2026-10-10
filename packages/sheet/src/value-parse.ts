import { serialOf } from "./dates.ts";
import { EN_US, type SheetLocale } from "./locales.ts";

/**
 * What someone typed into a cell, read in the sheet's locale: a number, a
 * date or time, a logical, or text. A number typed with a currency, a percent
 * sign, grouping or as a date also says how it wants to be shown, so the
 * cell takes that format too, as Excel does. Formulas (`=`) and forced text
 * (`'`) are the caller's.
 */
export type Typed =
  | { readonly kind: "empty" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "number"; readonly value: number; readonly format?: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CURRENCIES = ["$", "€", "£", "¥"];

/** A plain number in the locale: sign, grouping in threes, decimal part, exponent. */
function plainNumber(
  text: string,
  locale: SheetLocale,
): { value: number; grouped: boolean; places: number } | null {
  const group = escape(locale.group);
  const decimal = escape(locale.decimal);
  // French groups with a narrow or ordinary no-break space; people type a plain space too.
  const groupChars = locale.group.trim() === "" ? "[\\s\\u00a0\\u202f]" : group;
  const pattern = new RegExp(
    `^([+-])?(\\d{1,3}(?:${groupChars}\\d{3})+|\\d+)?(?:${decimal}(\\d*))?(?:[eE]([+-]?\\d+))?$`,
  );
  const match = pattern.exec(text);
  if (!match || (match[2] === undefined && !match[3])) return null;
  const whole = (match[2] ?? "0").replace(new RegExp(groupChars, "g"), "");
  const fraction = match[3] ?? "";
  const value = Number(`${match[1] ?? ""}${whole}.${fraction || "0"}e${match[4] ?? "0"}`);
  if (!Number.isFinite(value)) return null;
  return { value, grouped: whole !== (match[2] ?? "0"), places: match[4] ? 0 : fraction.length };
}

const decimals = (places: number) => (places > 0 ? `.${"0".repeat(Math.min(places, 10))}` : "");

/** Text in the locale's date order, ISO dates, and times with or without a meridiem. */
function dateTime(text: string, locale: SheetLocale): { value: number; format: string } | null {
  const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m?)?$/i;
  const clock = (raw: string): { value: number; format: string } | null => {
    const match = time.exec(raw);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] ?? 0);
    const meridiem = match[4]?.toLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return null;
      hour = (hour % 12) + (meridiem.startsWith("p") ? 12 : 0);
    }
    if (hour > 23 || minute > 59 || second > 59) return null;
    const format = `h:mm${match[3] ? ":ss" : ""}${meridiem ? " AM/PM" : ""}`;
    return { value: (hour * 3600 + minute * 60 + second) / 86_400, format };
  };
  const day = (raw: string): number | null => {
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
    const local = new RegExp(
      `^(\\d{1,4})[${escape(locale.dateSeparator)}/.-](\\d{1,2})[${escape(locale.dateSeparator)}/.-](\\d{2,4})$`,
    ).exec(raw);
    const [year, month, date] = iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : local
        ? locale.dateOrder === "MDY"
          ? [Number(local[3]), Number(local[1]), Number(local[2])]
          : locale.dateOrder === "DMY"
            ? [Number(local[3]), Number(local[2]), Number(local[1])]
            : [Number(local[1]), Number(local[2]), Number(local[3])]
        : [NaN, NaN, NaN];
    if (!Number.isInteger(year) || month < 1 || month > 12 || date < 1) return null;
    const fullYear = year < 100 ? (year < 30 ? 2000 + year : 1900 + year) : year;
    const last = new Date(Date.UTC(fullYear, month, 0)).getUTCDate();
    return date > last ? null : serialOf(fullYear, month, date);
  };
  const timed = clock(text);
  if (timed) return timed;
  const dated = day(text);
  if (dated !== null) return { value: dated, format: locale.shortDate };
  const split = /^(\S+)\s+(\S+(?:\s*[ap]m?)?)$/i.exec(text);
  if (!split) return null;
  const [date, hour] = [day(split[1]!), clock(split[2]!)];
  return date === null || !hour
    ? null
    : { value: date + hour.value, format: `${locale.shortDate} ${hour.format}` };
}

/** Reads one typed entry. */
export function parseTyped(raw: string, locale: SheetLocale = EN_US): Typed {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  const upper = text.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE") return { kind: "boolean", value: upper === "TRUE" };

  // A negative amount in parentheses, as accountants write it.
  const parenthesized = /^\((.*)\)$/.exec(text);
  const inner = parenthesized ? parenthesized[1]!.trim() : text;
  const sign = parenthesized ? -1 : 1;

  const percent = /^(.*?)\s*%$/.exec(inner);
  if (percent) {
    const number = plainNumber(percent[1]!, locale);
    if (number)
      return {
        kind: "number",
        value: (sign * number.value) / 100,
        format: `0${decimals(number.places)}%`,
      };
  }

  const symbols = [...new Set([locale.currency.symbol, ...CURRENCIES])];
  for (const symbol of symbols) {
    const at = new RegExp(
      `^([+-]?)\\s*${escape(symbol)}\\s*(.+)$|^(.+?)\\s*${escape(symbol)}$`,
    ).exec(inner);
    if (!at) continue;
    const body = at[2] !== undefined ? `${at[1]}${at[2]}` : at[3]!;
    const number = plainNumber(body, locale);
    if (!number) continue;
    const before = at[2] !== undefined;
    const amount = `#,##0${decimals(Math.max(number.places, symbol === "¥" ? 0 : 2))}`;
    const tag =
      symbol === locale.currency.symbol ? `[$${symbol}-${locale.currency.lcid}]` : `[$${symbol}]`;
    const format = before
      ? symbol === "$"
        ? `$${amount}`
        : `${tag}${amount}`
      : `${amount} ${tag}`;
    return { kind: "number", value: sign * number.value, format };
  }

  const number = plainNumber(inner, locale);
  if (number) {
    const format = number.grouped ? `#,##0${decimals(number.places)}` : undefined;
    return { kind: "number", value: sign * number.value, ...(format ? { format } : {}) };
  }
  if (!parenthesized) {
    const when = dateTime(text, locale);
    if (when) return { kind: "number", value: when.value, format: when.format };
  }
  return { kind: "text", value: raw };
}
