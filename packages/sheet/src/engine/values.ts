// Loaded by the spreadsheet worker under plain Node in development: relative imports only.
import type { CellBox } from "../a1.ts";
import { parseDateText } from "../dates.ts";

/** An Excel error value, e.g. #DIV/0!. */
export class XError {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}
export type Scalar = number | string | boolean | null | XError;

/** Where a range came from, so functions can tell a reference from a computed array. */
export interface Ref {
  readonly sheet: string;
  readonly box: CellBox;
}

/** A range or array: rows of scalars, and the reference it was read from, if any. */
export class Grid {
  readonly rows: Scalar[][];
  readonly ref: Ref | null;
  constructor(rows: Scalar[][], ref: Ref | null = null) {
    this.rows = rows;
    this.ref = ref;
  }
  get height() {
    return this.rows.length;
  }
  get width() {
    return this.rows[0]?.length ?? 0;
  }
}

/** Several references at once (a 3-D reference or a union): only aggregates take them. */
export class Areas {
  readonly grids: readonly Grid[];
  constructor(grids: readonly Grid[]) {
    this.grids = grids;
  }
}
export type Value = Scalar | Grid | Areas;

export const DIV0 = new XError("#DIV/0!");
export const VALUE = new XError("#VALUE!");
export const NA = new XError("#N/A");
export const NUM = new XError("#NUM!");
export const REF = new XError("#REF!");
export const NAME = new XError("#NAME?");
export const CALC = new XError("#CALC!");
export const SPILL = new XError("#SPILL!");
export const NULL = new XError("#NULL!");

const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i;
const GROUPED_NUMBER = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/**
 * Text Excel reads as a number (US conventions): plain and grouped numbers, a
 * currency sign, a trailing percent, accounting parentheses, a date or a time.
 */
export function parseNumberText(raw: string): number | null {
  let text = raw.trim();
  if (!text) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1).trim();
  }
  let scale = 1;
  if (text.endsWith("%")) {
    scale = 0.01;
    text = text.slice(0, -1).trim();
  }
  const currency = /^([-+]?)\s*\$\s*(.*)$/.exec(text);
  if (currency) text = `${currency[1]}${currency[2]}`;
  if (PLAIN_NUMBER.test(text) || GROUPED_NUMBER.test(text))
    return sign * scale * Number(text.replaceAll(",", ""));
  if (sign === 1 && scale === 1 && !currency) return parseDateText(text);
  return null;
}

export function toNumber(value: Scalar): number | XError {
  if (value instanceof XError) return value;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  return parseNumberText(value) ?? VALUE;
}

/** A number as Excel's General format writes it: up to 15 significant digits. */
export function numberText(value: number) {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  const rounded = Number(value.toPrecision(15));
  const plain = String(rounded);
  if (!plain.includes("e")) return plain;
  const [mantissa, exponent] = rounded.toExponential().split("e") as [string, string];
  const power = Number(exponent);
  return `${mantissa.toUpperCase()}E${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
}

export function toText(value: Scalar): string | XError {
  if (value instanceof XError) return value;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return typeof value === "number" ? numberText(value) : value;
}

export function toBoolean(value: Scalar): boolean | XError {
  if (value instanceof XError) return value;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === null) return false;
  const upper = value.trim().toUpperCase();
  return upper === "TRUE" ? true : upper === "FALSE" ? false : VALUE;
}

/** Excel keeps 15 significant digits, so 0.1+0.2 equals 0.3 there. */
export const round15 = (value: number) => (value === 0 ? 0 : Number(value.toPrecision(15)));

/** Excel orders numbers before text before booleans; text compares case-insensitively. */
export function compare(a: Scalar, b: Scalar): number {
  const rank = (value: Scalar) =>
    typeof value === "boolean" ? 2 : typeof value === "string" ? 1 : 0;
  // An empty cell is 0 beside a number, "" beside text and FALSE beside a boolean.
  if (a === null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b === null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string" && typeof b === "string") {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") {
    const [x, y] = [round15(a), round15(b)];
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return Number(a) - Number(b);
}

/** Every scalar of a value, row by row. */
export const flat = (value: Value): Scalar[] =>
  value instanceof Areas
    ? value.grids.flatMap((grid) => grid.rows.flat())
    : value instanceof Grid
      ? value.rows.flat()
      : [value];

/** One row or one column as a list; anything wider and taller is not a vector. */
export const vector = (value: Value): Scalar[] | null =>
  value instanceof Areas
    ? null
    : value instanceof Grid
      ? value.height === 1
        ? value.rows[0]!
        : value.width === 1
          ? value.rows.map((row) => row[0]!)
          : null
      : [value];

export const firstError = (values: Iterable<Scalar>): XError | null => {
  for (const value of values) if (value instanceof XError) return value;
  return null;
};

/** One run of a wildcard pattern between stars: characters, and null for `?`. */
type Segment = ReadonlyArray<string | null>;

function segmentAt(text: string, at: number, segment: Segment) {
  if (at + segment.length > text.length) return false;
  for (let index = 0; index < segment.length; index++) {
    const wanted = segment[index];
    if (wanted !== null && text[at + index] !== wanted) return false;
  }
  return true;
}
function findSegment(text: string, from: number, segment: Segment) {
  for (let at = from; at + segment.length <= text.length; at++)
    if (segmentAt(text, at, segment)) return at;
  return -1;
}

/**
 * A wildcard pattern (`*`, `?`, `~` escapes), matched case-insensitively
 * without regular expressions: the pattern is text from a cell, and stars
 * turned into `.*` backtrack exponentially. Each run between stars is found
 * leftmost in turn, which is exact for both questions asked here.
 */
export function wildcard(pattern: string) {
  const segments: Array<Array<string | null>> = [[]];
  const lower = pattern.toLowerCase();
  for (let index = 0; index < lower.length; index++) {
    const character = lower[index]!;
    if (character === "~" && index + 1 < lower.length && "*?~".includes(lower[index + 1]!))
      segments.at(-1)!.push(lower[++index]!);
    else if (character === "*") segments.push([]);
    else segments.at(-1)!.push(character === "?" ? null : character);
  }
  return {
    /** Whether the whole text matches. */
    test(raw: string) {
      const text = raw.toLowerCase();
      const first = segments[0]!;
      const last = segments.at(-1)!;
      if (segments.length === 1) return text.length === first.length && segmentAt(text, 0, first);
      if (!segmentAt(text, 0, first)) return false;
      const end = text.length - last.length;
      if (end < first.length || !segmentAt(text, end, last)) return false;
      let at = first.length;
      for (const segment of segments.slice(1, -1)) {
        const found = findSegment(text, at, segment);
        if (found < 0 || found + segment.length > end) return false;
        at = found + segment.length;
      }
      return true;
    },
    /** Where the first match starts, anything may follow it (SEARCH), or -1. */
    search(raw: string) {
      const text = raw.toLowerCase();
      const start = findSegment(text, 0, segments[0]!);
      if (start < 0) return -1;
      let at = start + segments[0]!.length;
      for (const segment of segments.slice(1)) {
        const found = findSegment(text, at, segment);
        if (found < 0) return -1;
        at = found + segment.length;
      }
      return start;
    },
  };
}
export const hasWildcard = (text: string) => /[*?~]/.test(text);
