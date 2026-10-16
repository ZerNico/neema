import type { Scalar } from "@chat/sheet/engine/values";
import type { ConditionalRule, ConditionalStyle, Threshold } from "@chat/sheet/conditional";
import type { SheetLocale } from "@chat/sheet/locales";
import { cellStyle } from "@chat/sheet/style";
import { cellDisplay } from "./display.ts";
import type { GridSheet } from "./grid-model.ts";

/** How conditional formats show one cell: a style, and a bar's length (0 to 1) and colour. */
export interface CellLook extends ConditionalStyle {
  readonly bar?: { readonly fraction: number; readonly color: string };
}

/**
 * Cells all of a sheet's rules together weigh every cell of their ranges for.
 * Past that, a rule weighs only the cells that hold something, which is all
 * its numbers and text, as the empty rest of the sheet adds nothing.
 */
const LOOK_CELLS = 200_000;

const channel = (hex: string, at: number) => Number.parseInt(hex.slice(at, at + 2), 16);
/** The colour a fraction of the way from one colour to another. */
function mix(from: string, to: string, fraction: number) {
  const part = (at: number) =>
    Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * fraction)
      .toString(16)
      .padStart(2, "0");
  return `#${part(1)}${part(3)}${part(5)}`.toUpperCase();
}

/**
 * How every cell a sheet's conditional formats reach shows, by `r|c`, from the
 * values the cells hold. A property the first rule sets is kept, as Excel
 * applies rules by priority.
 */
export function conditionalLooks(
  sheet: GridSheet,
  value: (r: string, c: string) => Scalar,
  locale: SheetLocale,
): Map<string, CellLook> {
  const looks = new Map<string, CellLook>();
  if (!sheet.conditional?.length) return looks;
  const add = (r: string, c: string, look: CellLook) => {
    const key = `${r}|${c}`;
    // The earlier rule's property stands.
    looks.set(key, { ...look, ...looks.get(key) });
  };
  const rowAt = new Map(sheet.rows.map((id, index) => [id, index]));
  const colAt = new Map(sheet.cols.map((id, index) => [id, index]));
  type Weighed = { r: string; c: string; value: Scalar; shown: string };
  // Each cell's text is worked out once, however many rules reach it.
  const known = new Map<string, Weighed>();
  const weighed = (r: string, c: string) => {
    const key = `${r}|${c}`;
    let cell = known.get(key);
    if (!cell) {
      const held = value(r, c);
      const style = cellStyle(sheet.cells[r]?.[c]?.s);
      cell = {
        r,
        c,
        value: held,
        shown: held === null ? "" : cellDisplay(held, style, locale).text,
      };
      known.set(key, cell);
    }
    return cell;
  };
  const filled = Object.entries(sheet.cells).flatMap(([r, row]) => {
    const at = rowAt.get(r);
    if (at === undefined) return [];
    return Object.keys(row).flatMap((c) => {
      const across = colAt.get(c);
      return across === undefined ? [] : [{ r, c, row: at, col: across }];
    });
  });
  let budget = LOOK_CELLS;
  for (const { box, rule } of sheet.conditional) {
    const [r1, r2] = [rowAt.get(box.r1), rowAt.get(box.r2)];
    const [c1, c2] = [colAt.get(box.c1), colAt.get(box.c2)];
    if (r1 === undefined || r2 === undefined || c1 === undefined || c2 === undefined) continue;
    const [top, bottom] = [Math.min(r1, r2), Math.max(r1, r2)];
    const [left, right] = [Math.min(c1, c2), Math.max(c1, c2)];
    const cells: Weighed[] = [];
    const area = (bottom - top + 1) * (right - left + 1);
    if (area <= budget) {
      budget -= area;
      for (const r of sheet.rows.slice(top, bottom + 1))
        for (const c of sheet.cols.slice(left, right + 1)) cells.push(weighed(r, c));
    } else
      for (const each of filled)
        if (each.row >= top && each.row <= bottom && each.col >= left && each.col <= right)
          cells.push(weighed(each.r, each.c));
    const numbers = cells.flatMap((cell) => (typeof cell.value === "number" ? [cell.value] : []));
    switch (rule.kind) {
      case "scale":
      case "bar": {
        if (!numbers.length) break;
        const at = place(numbers);
        const stops = (rule.stops ?? defaultStops(rule)).map(at);
        const [low, high] = [stops[0]!, stops.at(-1)!];
        for (const cell of cells) {
          const number = cell.value;
          if (typeof number !== "number") continue;
          const span = (from: number, to: number) =>
            to === from ? 1 : Math.min(1, Math.max(0, (number - from) / (to - from)));
          if (rule.kind === "bar") {
            add(cell.r, cell.c, {
              bar: { fraction: Math.max(0.05, span(low, high)), color: rule.color },
            });
            continue;
          }
          const [first, second, third] = rule.colors;
          const middle = stops[1]!;
          const fill = third
            ? number <= middle
              ? mix(first, second, low === middle ? 0 : span(low, middle))
              : mix(second, third, span(middle, high))
            : mix(first, second, span(low, high));
          add(cell.r, cell.c, { fill });
        }
        break;
      }
      default: {
        const test = matcher(rule, cells, numbers);
        for (const cell of cells) if (test(cell.value, cell.shown)) add(cell.r, cell.c, rule.style);
      }
    }
  }
  return looks;
}

const MIN = { type: "min" } as const;
const MAX = { type: "max" } as const;
/** Excel's stops for a rule that names none. */
const defaultStops = (rule: Extract<ConditionalRule, { kind: "scale" | "bar" }>) =>
  rule.kind === "scale" && rule.colors.length === 3
    ? [MIN, { type: "percentile", value: 50 } as const, MAX]
    : [MIN, MAX];

/** Where each stop falls among a range's numbers; percentiles interpolate as PERCENTILE.INC does. */
function place(numbers: readonly number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const [low, high] = [sorted[0]!, sorted.at(-1)!];
  return (stop: Threshold) => {
    switch (stop.type) {
      case "min":
        return low;
      case "max":
        return high;
      case "number":
        return stop.value;
      case "percent":
        return low + ((high - low) * stop.value) / 100;
      case "percentile": {
        const rank = (Math.min(100, Math.max(0, stop.value)) / 100) * (sorted.length - 1);
        const below = Math.floor(rank);
        const above = sorted[Math.min(below + 1, sorted.length - 1)]!;
        return sorted[below]! + (above - sorted[below]!) * (rank - below);
      }
    }
  };
}

/** Whether a cell meets a highlight rule, given the range's cells and numbers it is judged among. */
function matcher(
  rule: Exclude<ConditionalRule, { kind: "scale" | "bar" }>,
  cells: ReadonlyArray<{ shown: string }>,
  numbers: readonly number[],
): (value: unknown, shown: string) => boolean {
  switch (rule.kind) {
    case "compare": {
      const [a, b] = rule.values.map((each) => (typeof each === "number" ? each : Number(each)));
      const textual =
        typeof rule.values[0] === "string" && !Number.isFinite(Number(rule.values[0]));
      return (value, shown) => {
        if (textual) {
          const same = shown.toLowerCase() === String(rule.values[0]).toLowerCase();
          return rule.op === "equal" ? same : rule.op === "notEqual" ? !same : false;
        }
        if (typeof value !== "number") return false;
        const [low, high] = [Math.min(a!, b ?? a!), Math.max(a!, b ?? a!)];
        switch (rule.op) {
          case "greater":
            return value > a!;
          case "greaterOrEqual":
            return value >= a!;
          case "less":
            return value < a!;
          case "lessOrEqual":
            return value <= a!;
          case "equal":
            return value === a;
          case "notEqual":
            return value !== a;
          case "between":
            return value >= low && value <= high;
          case "notBetween":
            return value < low || value > high;
        }
      };
    }
    case "text": {
      const wanted = rule.text.toLowerCase();
      return (_, shown) => {
        const text = shown.toLowerCase();
        return rule.op === "contains"
          ? text.includes(wanted)
          : rule.op === "notContains"
            ? !text.includes(wanted)
            : rule.op === "beginsWith"
              ? text.startsWith(wanted)
              : text.endsWith(wanted);
      };
    }
    case "top": {
      const sorted = numbers.toSorted((x, y) => (rule.bottom ? x - y : y - x));
      const count = rule.percent
        ? Math.max(1, Math.floor((sorted.length * rule.count) / 100))
        : rule.count;
      const edge = sorted[Math.min(count, sorted.length) - 1];
      return (value) =>
        typeof value === "number" &&
        edge !== undefined &&
        (rule.bottom ? value <= edge : value >= edge);
    }
    case "average": {
      const mean = numbers.reduce((sum, each) => sum + each, 0) / (numbers.length || 1);
      return (value) => typeof value === "number" && (rule.below ? value < mean : value > mean);
    }
    case "duplicate": {
      const counts = new Map<string, number>();
      for (const cell of cells)
        if (cell.shown)
          counts.set(cell.shown.toLowerCase(), (counts.get(cell.shown.toLowerCase()) ?? 0) + 1);
      return (_, shown) => {
        if (!shown) return false;
        const many = (counts.get(shown.toLowerCase()) ?? 0) > 1;
        return rule.unique ? !many : many;
      };
    }
    case "blank":
      return (_, shown) => (rule.not ? shown !== "" : shown === "");
  }
}
