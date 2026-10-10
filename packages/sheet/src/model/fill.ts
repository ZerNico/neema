import { partsOf, serialOf } from "../dates.ts";
import { EN_US, type SheetLocale } from "../locales.ts";
import { copyFormula } from "./formula.ts";
import { positions, type Box, type Cell, type CellValue, type SheetDoc } from "./model.ts";
import type { CellWrite, SheetOp, StylePatch } from "./ops.ts";

export type FillDirection = "down" | "up" | "right" | "left";
/**
 * `auto` continues what the cells start, as dragging Excel's fill handle
 * does; `alternate` is the same drag with Ctrl held: copies where auto
 * would count, and counts on from a single number. `copy` and `series` are
 * Excel's Auto Fill Options, forcing one or the other.
 */
export type FillMode = "auto" | "alternate" | "copy" | "series";
/** What a fill writes: contents and formats, contents alone, or formats alone. */
export type FillPart = "all" | "values" | "formats";

/** What one source cell holds, as a fill reads it. */
interface Source {
  readonly cell: Cell | undefined;
  readonly format: string | undefined;
}
/** A target's content, by its distance along the fill from the cell it continues. */
type Filled =
  | { readonly kind: "value"; readonly v: CellValue | null; readonly from: number }
  | { readonly kind: "formula"; readonly from: number; readonly offset: number };

/** A number format with its literal text and colour or locale brackets taken out. */
const bareFormat = (format: string) =>
  format.replace(/"[^"]*"|\\./g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
/** Shows a date (a day, month or year), or only a time of day. */
const isDate = (source: Source) => {
  if (typeof source.cell?.v !== "number" || !source.format) return false;
  const format = bareFormat(source.format);
  return /[dy]/i.test(format) || (/m/i.test(format) && !/[hs]/i.test(format));
};
const isTime = (source: Source) =>
  typeof source.cell?.v === "number" &&
  !!source.format &&
  /[hs]/i.test(bareFormat(source.format)) &&
  !isDate(source);
const formatOf = (cell: Cell | undefined) => {
  if (!cell?.s) return undefined;
  const style = JSON.parse(cell.s) as { numberFormat?: unknown };
  return typeof style.numberFormat === "string" ? style.numberFormat : undefined;
};

/** The least-squares line through values at 0, 1, 2…: Excel's linear trend. */
function trend(values: readonly number[]) {
  const n = values.length;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((sum, value) => sum + value, 0) / n;
  let [top, bottom] = [0, 0];
  for (const [x, y] of values.entries()) {
    top += (x - meanX) * (y - meanY);
    bottom += (x - meanX) ** 2;
  }
  const slope = bottom ? top / bottom : 0;
  return (x: number) => {
    const value = meanY + slope * (x - meanX);
    // Steps such as 0.1 should land on 0.3, not 0.30000000000000004.
    return Math.round(value * 1e10) / 1e10;
  };
}

/** Name lists a fill cycles through, in the sheet's language and in English. */
const listsOf = (of: SheetLocale) => [of.days, of.daysShort, of.months, of.monthsShort];
function nameLists(locale: SheetLocale) {
  return locale === EN_US ? listsOf(EN_US) : [...listsOf(locale), ...listsOf(EN_US)];
}
/** A name as written again in the case its source used. */
const recase = (name: string, like: string) =>
  like === like.toUpperCase()
    ? name.toUpperCase()
    : like === like.toLowerCase()
      ? name.toLowerCase()
      : name;

/** Days in a month, from the serials of its first day and the next month's. */
const daysIn = (year: number, month: number) =>
  (serialOf(year, month + 1, 1) ?? 0) - (serialOf(year, month, 1) ?? 0);

/** Continues dates by day, or by month or year when the source steps by whole ones. */
function dateSeries(serials: readonly number[]): ((x: number) => number) | null {
  const parts = serials.map((serial) => partsOf(serial));
  if (parts.some((each) => !each)) return null;
  const dates = parts.map((each) => each!);
  if (dates.length === 1) return (x) => serials[0]! + x;
  const sameDay = dates.every((each) => each.day === dates[0]!.day);
  const months = dates.map((each) => each.year * 12 + (each.month - 1));
  const monthStep = months[1]! - months[0]!;
  const first = months[0]!;
  const evenMonths = months.every((month, index) => month - first === monthStep * index);
  // The last days of months step by months too, and stay on each month's last day.
  const monthEnds = dates.every((each) => each.day === daysIn(each.year, each.month));
  if ((sameDay || monthEnds) && monthStep !== 0 && evenMonths) {
    const day = monthEnds ? 31 : dates[0]!.day;
    return (x) => {
      const total = months[0]! + monthStep * x;
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      // A day past a month's end (the 31st in April) is its last day, as Excel does.
      return serialOf(year, month, Math.min(day, daysIn(year, month))) ?? serials[0]!;
    };
  }
  return trend(serials);
}

/** Text around its last number, the number's width, and an ordinal ending such as "st". */
function numberedText(text: string) {
  const match = /^(.*?)(\d+)(\D*)$/.exec(text);
  if (!match) return null;
  const [before, digits, after] = [match[1] ?? "", match[2] ?? "", match[3] ?? ""];
  const ordinal = /^(st|nd|rd|th)(?![a-z])/i.exec(after)?.[0] ?? null;
  return {
    before,
    number: Number(digits),
    width: digits.length,
    after: ordinal ? after.slice(ordinal.length) : after,
    ordinal: ordinal !== null,
    upper: ordinal !== null && ordinal === ordinal.toUpperCase(),
    // Quarters count 1 to 4 and round again: Q3, Qtr4, Quarter 1.
    quarter: /^(q|qtr|quarter)\s*$/i.test(before) && Number(digits) >= 1 && Number(digits) <= 4,
  };
}
const ordinalOf = (n: number) => {
  const tens = Math.abs(n) % 100;
  const ones = Math.abs(n) % 10;
  return tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][ones] ?? "th");
};
/** Numbered text written again with another number, in the source's width and endings. */
function renumber(like: NonNullable<ReturnType<typeof numberedText>>, n: number) {
  const number = like.quarter ? ((((n - 1) % 4) + 4) % 4) + 1 : n;
  const digits = number < 0 ? String(number) : String(number).padStart(like.width, "0");
  const ordinal = like.ordinal ? ordinalOf(number) : "";
  return `${like.before}${digits}${like.upper ? ordinal.toUpperCase() : ordinal}${like.after}`;
}

/** A name list a text belongs to, and its place there. */
function nameOf(text: string, locale: SheetLocale) {
  for (const list of nameLists(locale)) {
    const index = list.findIndex((name) => name.toLowerCase() === text.toLowerCase());
    if (index !== -1) return { list, index };
  }
  return null;
}

/**
 * How one line of a fill continues: what goes at each distance `x` along it
 * (0 being the first source). Cells of one kind continue together, as a
 * series; a mix continues each place on its own, as Excel turns "text1,
 * textA" into "text2, textA, text3, textA".
 */
function continuation(
  sources: readonly Source[],
  mode: FillMode,
  locale: SheetLocale,
): (x: number) => Filled {
  const n = sources.length;
  const place = (x: number) => ((x % n) + n) % n;
  const repeat = (x: number): Filled => {
    const from = place(x);
    const source = sources[from]!.cell;
    return source?.f
      ? { kind: "formula", from, offset: x - from }
      : { kind: "value", v: source?.v ?? null, from };
  };
  if (mode === "copy") return repeat;
  /** Whether a run counts on: one plain number only when asked, anything else unless asked not to. */
  const counts = (byDefault: boolean) =>
    mode === "series" ? true : mode === "alternate" ? !byDefault : byDefault;
  const values = sources.map((source) => (source.cell?.f ? undefined : source.cell?.v));
  const value =
    (v: CellValue | null) =>
    (x: number): Filled => ({ kind: "value", v, from: place(x) });

  // ---- one kind throughout: a series over the whole run
  if (values.every((each) => typeof each === "number")) {
    const numbers = values as number[];
    const dated = sources.every(isDate);
    const timed = !dated && sources.every(isTime);
    if (!counts(dated || timed || n > 1)) return repeat;
    const at = dated
      ? (dateSeries(numbers) ?? trend(numbers))
      : timed && n === 1
        ? (x: number) => Math.round((numbers[0]! + x / 24) * 1e10) / 1e10
        : n === 1
          ? (x: number) => numbers[0]! + x
          : trend(numbers);
    return (x) => value(at(x))(x);
  }
  if (values.every((each) => typeof each === "string")) {
    const texts = values as string[];
    const numbered = texts.map(numberedText);
    const first = numbered[0];
    if (
      first &&
      numbered.every((each) => each && each.before === first.before && each.after === first.after)
    ) {
      if (!counts(true)) return repeat;
      const numbers = numbered.map((each) => each!.number);
      const at = n === 1 ? (x: number) => numbers[0]! + x : trend(numbers);
      return (x) => value(renumber(first, Math.round(at(x))))(x);
    }
    // The first list that names every cell: "JAN, MAR" are English even in a German sheet.
    const lower = texts.map((text) => text.toLowerCase());
    const list = nameLists(locale).find((names) =>
      lower.every((text) => names.some((name) => name.toLowerCase() === text)),
    );
    if (list) {
      if (!counts(true)) return repeat;
      const indexes = lower.map((text) => list.findIndex((name) => name.toLowerCase() === text));
      const step = n === 1 ? 1 : indexes[1]! - indexes[0]!;
      return (x) => {
        const index = (((indexes[0]! + step * x) % list.length) + list.length) % list.length;
        return value(recase(list[index]!, texts[0]!))(x);
      };
    }
  }

  // ---- a mix: each place continues on its own, a step per round
  if (n === 1 || !counts(true)) return repeat;
  return (x) => {
    const from = place(x);
    const round = (x - from) / n;
    const source = sources[from]!;
    const v = source.cell?.f ? undefined : source.cell?.v;
    if (v === undefined || v === null || round === 0) return repeat(x);
    if (typeof v === "number" && isDate(source)) return value(v + round)(x);
    if (typeof v === "number" && isTime(source))
      return value(Math.round((v + round / 24) * 1e10) / 1e10)(x);
    if (typeof v === "string") {
      const numbered = numberedText(v);
      if (numbered) return value(renumber(numbered, numbered.number + round))(x);
      const name = nameOf(v, locale);
      if (name) {
        const index =
          (((name.index + round) % name.list.length) + name.list.length) % name.list.length;
        return value(recase(name.list[index]!, v))(x);
      }
    }
    return repeat(x);
  };
}

/** The style a target takes from its source: the source's own, and what else the target had removed. */
function stylePatch(source: Cell | undefined, target: Cell | undefined): StylePatch | null {
  const from = source?.s ? (JSON.parse(source.s) as Record<string, string | number | boolean>) : {};
  const to = target?.s ? (JSON.parse(target.s) as Record<string, unknown>) : {};
  const patch: Record<string, string | number | boolean | null> = { ...from };
  for (const key of Object.keys(to)) if (!(key in from)) patch[key] = null;
  return Object.keys(patch).length ? patch : null;
}

/**
 * Fills `count` cells on from `source` in one direction, as dragging the
 * fill handle does: each row (or column) of the source continues on its
 * own, and targets take their source's format. The target cells must exist.
 */
export function fillSeries(
  doc: SheetDoc,
  sheet: string,
  source: Box,
  direction: FillDirection,
  count: number,
  mode: FillMode = "auto",
  locale: SheetLocale = EN_US,
  part: FillPart = "all",
): SheetOp[] {
  const data = doc.sheet[sheet];
  if (!data || count < 1) return [];
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [top, bottom, left, right] = [
    rows.at(source.r1),
    rows.at(source.r2),
    cols.at(source.c1),
    cols.at(source.c2),
  ];
  if (top === undefined || bottom === undefined || left === undefined || right === undefined)
    return [];
  const vertical = direction === "down" || direction === "up";
  const forward = direction === "down" || direction === "right";
  // Lines run along the fill; each is the source's cells in one column (or row).
  const [alongStart, alongEnd] = vertical ? [top, bottom] : [left, right];
  const [acrossStart, acrossEnd] = vertical ? [left, right] : [top, bottom];
  const length = alongEnd - alongStart + 1;
  const along = vertical ? rows.ids : cols.ids;
  const across = vertical ? cols.ids : rows.ids;
  const cellAt = (a: number, b: number) => {
    const [r, c] = vertical ? [along[a - 1]!, across[b - 1]!] : [across[b - 1]!, along[a - 1]!];
    return { r, c, cell: data.cells[r]?.[c] };
  };
  const writes: CellWrite[] = [];
  const styles: SheetOp[] = [];
  for (let line = acrossStart; line <= acrossEnd; line++) {
    const cells = Array.from({ length }, (_, index) => cellAt(alongStart + index, line).cell);
    const next = continuation(
      cells.map((cell) => ({ cell, format: formatOf(cell) })),
      mode,
      locale,
    );
    for (let step = 1; step <= count; step++) {
      // Distance from the first source: past the last going forward, before the first going back.
      const x = forward ? length - 1 + step : -step;
      const position = alongStart + x;
      if (position < 1 || position > along.length) break;
      const target = cellAt(position, line);
      const filled = next(x);
      if (part === "formats") {
        // Formats alone leave the contents and take each place's style in turn.
      } else if (filled.kind === "formula") {
        const formula = cells[filled.from]!.f!;
        const shifted = copyFormula(
          formula,
          vertical ? { rows: filled.offset, cols: 0 } : { rows: 0, cols: filled.offset },
          { doc, sheet },
        );
        writes.push(
          "formula" in shifted
            ? { r: target.r, c: target.c, f: shifted.formula }
            : { r: target.r, c: target.c, v: "#REF!" },
        );
      } else writes.push({ r: target.r, c: target.c, v: filled.v });
      // Formats repeat by place, as Excel copies them, whatever the values do.
      const patch =
        part === "values" ? null : stylePatch(cells[((x % length) + length) % length], target.cell);
      if (patch)
        styles.push({
          op: "format",
          sh: sheet,
          area: { r1: target.r, r2: target.r, c1: target.c, c2: target.c },
          patch,
        });
    }
  }
  return [...(writes.length ? [{ op: "set" as const, sh: sheet, cells: writes }] : []), ...styles];
}
