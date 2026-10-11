import { extent } from "../engine/values.ts";
import { placeBox } from "./box.ts";
import type { SheetValues } from "./calc.ts";
import { shownText } from "./filter.ts";
import type { Box, SheetDoc } from "./model.ts";
import { isColor, isId, isRecord } from "./check.ts";

/**
 * Conditional formats, as Excel's Home tab makes them: rules over ranges that
 * colour cells by their values. Like a filter, what they show is worked out
 * when drawn, so a changed value recolours its cell on every replica at once.
 */

/** What a matching cell takes; colours are #RRGGBB. */
export interface ConditionalStyle {
  readonly fill?: string;
  readonly fontColor?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}
export const COMPARISONS = [
  "greater",
  "greaterOrEqual",
  "less",
  "lessOrEqual",
  "equal",
  "notEqual",
  "between",
  "notBetween",
] as const;
export const TEXT_TESTS = ["contains", "notContains", "beginsWith", "endsWith"] as const;
export type ConditionalRule =
  | {
      readonly kind: "compare";
      readonly op: (typeof COMPARISONS)[number];
      readonly values: readonly [number | string] | readonly [number | string, number | string];
      readonly style: ConditionalStyle;
    }
  | {
      readonly kind: "text";
      readonly op: (typeof TEXT_TESTS)[number];
      readonly text: string;
      readonly style: ConditionalStyle;
    }
  | {
      readonly kind: "top";
      readonly count: number;
      readonly percent?: boolean;
      readonly bottom?: boolean;
      readonly style: ConditionalStyle;
    }
  | { readonly kind: "average"; readonly below?: boolean; readonly style: ConditionalStyle }
  | { readonly kind: "duplicate"; readonly unique?: boolean; readonly style: ConditionalStyle }
  | { readonly kind: "blank"; readonly not?: boolean; readonly style: ConditionalStyle }
  /** Colours from the smallest number to the largest, through a middle one when given. */
  | {
      readonly kind: "scale";
      readonly colors: readonly [string, string] | readonly [string, string, string];
    }
  /** A bar across each cell, as long as its number is large among the range's. */
  | { readonly kind: "bar"; readonly color: string };

export interface ConditionalFormat {
  readonly id: string;
  readonly box: Box;
  readonly rule: ConditionalRule;
}

/** How conditional formats show one cell: a style, and a bar's length (0 to 1) and colour. */
export interface CellLook extends ConditionalStyle {
  readonly bar?: { readonly fraction: number; readonly color: string };
}

/**
 * Whether a format judges each cell against its whole range (top ten, above
 * average, duplicates, a colour scale or bar): split, each piece would judge
 * on its own, so clearing part of its cells leaves it whole.
 */
export const rangeWide = (format: ConditionalFormat) =>
  format.rule.kind !== "compare" && format.rule.kind !== "text" && format.rule.kind !== "blank";

export const CONDITIONAL_LIMITS = { rules: 100, text: 255 } as const;

const isOperand = (value: unknown) =>
  (typeof value === "number" && Number.isFinite(value)) ||
  (typeof value === "string" && value.length <= CONDITIONAL_LIMITS.text);
const isStyle = (value: unknown) =>
  isRecord(value) &&
  (value.fill === undefined || isColor(value.fill)) &&
  (value.fontColor === undefined || isColor(value.fontColor)) &&
  (value.bold === undefined || typeof value.bold === "boolean") &&
  (value.italic === undefined || typeof value.italic === "boolean");

function isRule(rule: unknown): boolean {
  if (!isRecord(rule)) return false;
  switch (rule.kind) {
    case "compare":
      return (
        COMPARISONS.includes(rule.op as (typeof COMPARISONS)[number]) &&
        Array.isArray(rule.values) &&
        rule.values.length >= 1 &&
        rule.values.length <= 2 &&
        rule.values.every(isOperand) &&
        isStyle(rule.style)
      );
    case "text":
      return (
        TEXT_TESTS.includes(rule.op as (typeof TEXT_TESTS)[number]) &&
        typeof rule.text === "string" &&
        rule.text.length <= CONDITIONAL_LIMITS.text &&
        isStyle(rule.style)
      );
    case "top":
      return (
        typeof rule.count === "number" &&
        Number.isInteger(rule.count) &&
        rule.count >= 1 &&
        rule.count <= 1000 &&
        isStyle(rule.style)
      );
    case "average":
    case "duplicate":
    case "blank":
      return isStyle(rule.style);
    case "scale":
      return (
        Array.isArray(rule.colors) &&
        rule.colors.length >= 2 &&
        rule.colors.length <= 3 &&
        rule.colors.every(isColor)
      );
    case "bar":
      return isColor(rule.color);
    default:
      return false;
  }
}

/** Whether a list of conditional formats, as an operation carries one, is well formed. */
export function isConditionalList(value: unknown): value is readonly ConditionalFormat[] {
  return (
    Array.isArray(value) &&
    value.length <= CONDITIONAL_LIMITS.rules &&
    value.every(
      (each) =>
        isRecord(each) &&
        isId(each.id) &&
        isRecord(each.box) &&
        [each.box.r1, each.box.r2, each.box.c1, each.box.c2].every(isId) &&
        isRule(each.rule),
    )
  );
}

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
 * How every cell a sheet's conditional formats reach shows, by `r|c`. A
 * property the first rule sets is kept, as Excel applies rules by priority.
 */
export function conditionalLooks(
  doc: SheetDoc,
  values: SheetValues,
  sheet: string,
): Map<string, CellLook> {
  const looks = new Map<string, CellLook>();
  const data = doc.sheet[sheet];
  if (!data?.conditional?.length) return looks;
  const add = (r: string, c: string, look: CellLook) => {
    const key = `${r}|${c}`;
    // The earlier rule's property stands.
    looks.set(key, { ...look, ...looks.get(key) });
  };
  for (const { box, rule } of data.conditional) {
    const placed = placeBox(data, box);
    if (!placed) continue;
    const cells: Array<{ r: string; c: string; value: unknown; shown: string }> = [];
    for (const r of placed.rows)
      for (const c of placed.cols)
        cells.push({
          r,
          c,
          value: values.value(sheet, r, c),
          shown: shownText(doc, values, sheet, r, c),
        });
    const numbers = cells.flatMap((cell) => (typeof cell.value === "number" ? [cell.value] : []));
    switch (rule.kind) {
      case "scale":
      case "bar": {
        if (!numbers.length) break;
        const [low, high] = extent(numbers);
        const middle = (low + high) / 2;
        for (const cell of cells) {
          if (typeof cell.value !== "number") continue;
          const fraction = high === low ? 1 : (cell.value - low) / (high - low);
          if (rule.kind === "bar") {
            add(cell.r, cell.c, { bar: { fraction: Math.max(0.05, fraction), color: rule.color } });
            continue;
          }
          const [first, second, third] = rule.colors;
          const fill = third
            ? cell.value <= middle
              ? mix(first, second, high === low ? 0 : (cell.value - low) / (middle - low))
              : mix(second, third, (cell.value - middle) / (high - middle))
            : mix(first, second, fraction);
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
