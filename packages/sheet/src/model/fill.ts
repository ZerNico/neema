import { partsOf, serialOf } from "../dates.ts";
import { EN_US, type SheetLocale } from "../locales.ts";
import { copyFormula } from "./formula.ts";
import { positions, type Box, type Cell, type CellValue, type SheetDoc } from "./model.ts";
import type { CellWrite, SheetOp, StylePatch } from "./ops.ts";

export type FillDirection = "down" | "up" | "right" | "left";
/**
 * `auto` continues what the cells start, as dragging Excel's fill handle
 * does; `alternate` is the same drag with Ctrl held: copies where auto
 * would count, and counts on from a single number.
 */
export type FillMode = "auto" | "alternate";

/** What one source cell holds, as a fill reads it. */
interface Source {
  readonly cell: Cell | undefined;
  readonly format: string | undefined;
}
/** A target's content, by its distance along the fill from the cell it continues. */
type Filled =
  | { readonly kind: "value"; readonly v: CellValue | null; readonly from: number }
  | { readonly kind: "formula"; readonly from: number; readonly offset: number };

const DATE_FORMAT = /[dmy]/i;
const isDate = (source: Source) =>
  typeof source.cell?.v === "number" &&
  !!source.format &&
  DATE_FORMAT.test(source.format.replace(/"[^"]*"|\[[^\]]*\]/g, ""));
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
  if (sameDay && monthStep !== 0 && evenMonths) {
    const { day } = dates[0]!;
    return (x) => {
      const total = months[0]! + monthStep * x;
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      // The 31st continues as each month's last day, as Excel does.
      for (let last = day; last >= 28; last--) {
        const serial = serialOf(year, month, last);
        if (serial !== null) return serial;
      }
      return serialOf(year, month, Math.min(day, 28)) ?? serials[0]!;
    };
  }
  return trend(serials);
}

/**
 * How one line of a fill continues: its sources in order, and what goes at
 * each distance `x` along it (0 being the first source). Formulas and mixed
 * lines repeat, shifting formulas; numbers, dates, numbered text and day and
 * month names count on.
 */
function continuation(
  sources: readonly Source[],
  mode: FillMode,
  locale: SheetLocale,
): (x: number) => Filled {
  const n = sources.length;
  const repeat = (x: number): Filled => {
    const from = ((x % n) + n) % n;
    const source = sources[from]!.cell;
    return source?.f
      ? { kind: "formula", from, offset: x - from }
      : { kind: "value", v: source?.v ?? null, from };
  };
  const values = sources.map((source) => (source.cell?.f ? undefined : source.cell?.v));
  if (values.some((value) => value === undefined || value === null)) return repeat;

  if (values.every((value) => typeof value === "number")) {
    const numbers = values as number[];
    const dated = sources.every(isDate);
    // One plain number is copied unless Ctrl is held; dates and runs count unless it is.
    const counts = dated || n > 1 ? mode === "auto" : mode === "alternate";
    if (!counts) return repeat;
    const at = dated
      ? (dateSeries(numbers) ?? trend(numbers))
      : n === 1
        ? (x: number) => numbers[0]! + x
        : trend(numbers);
    return (x) => ({ kind: "value", v: at(x), from: 0 });
  }
  if (mode === "alternate" || !values.every((value) => typeof value === "string")) return repeat;
  const texts = values as string[];

  // "Item 1", "Q3", "Week 07": the same text before a number that counts on.
  const numbered = texts.map((text) => /^(.*?)(\d+)$/.exec(text));
  if (numbered.every((match) => match && match[1] === numbered[0]![1])) {
    const prefix = numbered[0]![1]!;
    const width = numbered[0]![2]!.length;
    const numbers = numbered.map((match) => Number(match![2]));
    const at = n === 1 ? (x: number) => numbers[0]! + x : trend(numbers);
    return (x) => {
      const next = Math.round(at(x));
      return {
        kind: "value",
        v: `${prefix}${next < 0 ? next : String(next).padStart(width, "0")}`,
        from: 0,
      };
    };
  }

  // Day and month names cycle on, by the source's step.
  for (const list of nameLists(locale)) {
    const lower = list.map((name) => name.toLowerCase());
    const indexes = texts.map((text) => lower.indexOf(text.toLowerCase()));
    if (indexes.some((index) => index === -1)) continue;
    const step = n === 1 ? 1 : indexes[1]! - indexes[0]!;
    return (x) => {
      const index = (((indexes[0]! + step * x) % list.length) + list.length) % list.length;
      return { kind: "value", v: recase(list[index]!, texts[0]!), from: 0 };
    };
  }
  return repeat;
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
      if (filled.kind === "formula") {
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
      const patch = stylePatch(cells[filled.from], target.cell);
      if (patch)
        styles.push({
          op: "format",
          sh: sheet,
          area: { r1: target.r, r2: target.r, c1: target.c, c2: target.c },
          patch,
        });
    }
  }
  return writes.length ? [{ op: "set", sh: sheet, cells: writes }, ...styles] : [];
}
