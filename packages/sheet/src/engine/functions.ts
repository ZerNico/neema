import * as library from "@formulajs/formulajs";
import type { CellBox } from "../a1.ts";
import { formatValue } from "../number-format.ts";
import { clockOf, parseDateText, partsOf, serialOf, weekdayOf } from "../dates.ts";
import {
  Areas,
  CALC,
  compare,
  DIV0,
  firstError,
  flat,
  Grid,
  hasWildcard,
  NA,
  NUM,
  parseNumberText,
  REF,
  round15,
  toBoolean,
  toNumber,
  toText,
  VALUE,
  vector,
  wildcard,
  extent,
  XError,
  type Ref,
  type Scalar,
  type Value,
} from "./values.ts";

/**
 * How a function reads each argument:
 * - `s` a single value; a range or array there is lifted element by element
 *   (or, in a formula without dynamic arrays, intersected with the formula's row)
 * - `r` a reference or array, as it is
 * - `a` an array: its expression is evaluated element by element even in a
 *   legacy formula, as SUMPRODUCT does
 * - `v` any single value or array, never lifted
 * The kinds after `|` repeat for the remaining arguments; without one they are `s`.
 */
export const kindAt = (kinds: string, index: number): string => {
  const [prefix, repeat = ""] = kinds.split("|") as [string, string?];
  if (index < prefix.length) return prefix[index]!;
  return repeat ? repeat[(index - prefix.length) % repeat.length]! : "s";
};

/** What a function sees besides its arguments. */
export interface Call {
  readonly sheet: string;
  readonly row: number;
  readonly column: number;
  /** Whether argument `index` was left out, as in IF(A1,,2). */
  omitted(index: number): boolean;
  /** A reference's cells as a range. */
  cells(ref: Ref): Grid;
  /** Text read as a reference (INDIRECT), or null. */
  reference(text: string, a1: boolean): Grid | Areas | null;
  isFormula(sheet: string, row: number, column: number): boolean;
  spill(sheet: string, row: number, column: number): CellBox | null;
}

export interface Fn {
  readonly kinds?: string;
  /** Error values reach the function instead of being its result. */
  readonly errors?: true;
  readonly run: (args: Value[], call: Call) => Value;
}

const scalar = (value: Value | undefined): Scalar =>
  value === undefined
    ? null
    : value instanceof Areas
      ? VALUE
      : value instanceof Grid
        ? (value.rows[0]?.[0] ?? null)
        : value;
const number = (value: Value | undefined): number | XError => toNumber(scalar(value));
const text = (value: Value | undefined): string | XError => toText(scalar(value));
/** An optional numeric argument: its fallback when left out. */
const optionalNumber = (args: Value[], call: Call, index: number, fallback: number) =>
  call.omitted(index) || args[index] === undefined ? fallback : number(args[index]);
const optionalBoolean = (args: Value[], call: Call, index: number, fallback: boolean) =>
  call.omitted(index) || args[index] === undefined ? fallback : toBoolean(scalar(args[index]));

// ---------------------------------------------------------------------------
// Aggregates

// A range's numbers by its rows, strict and lenient. Ranges are never changed once read, and a
// pass hands the same rows to every formula reading one: a column summed by a thousand
// formulas is read once.
const strictNumbers = new WeakMap<Scalar[][], number[] | XError>();
const lenientNumbers = new WeakMap<Scalar[][], number[] | XError>();
function gridNumbers(grid: Grid, lenient: boolean): number[] | XError {
  const cache = lenient ? lenientNumbers : strictNumbers;
  const known = cache.get(grid.rows);
  if (known) return known;
  let numbers: number[] | XError = [];
  read: for (const row of grid.rows)
    for (const item of row) {
      if (item instanceof XError) {
        numbers = item;
        break read;
      }
      if (typeof item === "number") numbers.push(item);
      else if (lenient && typeof item === "boolean") numbers.push(item ? 1 : 0);
      else if (lenient && typeof item === "string") numbers.push(0);
    }
  cache.set(grid.rows, numbers);
  return numbers;
}

/**
 * Numbers as SUM reads them: a range or array gives only its numbers; a value
 * written as an argument is converted, and text that isn't a number fails.
 * `lenient` is the A-functions' reading: text counts 0 and TRUE 1.
 */
function numbersOf(args: Value[], call: Call, lenient = false): number[] | XError {
  // One range alone, as SUM(A1:A2000) has: its numbers as read before, copied for the caller.
  if (args.length === 1 && args[0] instanceof Grid) {
    const numbers = gridNumbers(args[0], lenient);
    return numbers instanceof XError ? numbers : numbers.slice();
  }
  const found: number[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg instanceof Grid || arg instanceof Areas) {
      for (const grid of arg instanceof Areas ? arg.grids : [arg]) {
        const numbers = gridNumbers(grid, lenient);
        if (numbers instanceof XError) return numbers;
        for (const each of numbers) found.push(each);
      }
      continue;
    }
    if (call.omitted(index)) continue;
    if (arg === null) continue;
    const converted = toNumber(arg);
    if (converted instanceof XError) return converted;
    found.push(converted);
  }
  return found;
}

const onNumbers =
  (compute: (values: number[]) => Value, lenient = false): Fn["run"] =>
  (args, call) => {
    const values = numbersOf(args, call, lenient);
    return values instanceof XError ? values : compute(values);
  };
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const average = (values: number[]) => (values.length ? sum(values) / values.length : DIV0);
const max = (values: number[]) => (values.length ? extent(values)[1] : 0);
const min = (values: number[]) => (values.length ? extent(values)[0] : 0);

/** A formula.js statistic over the numbers alone, so its own coercion never runs. */
const libraryStat =
  (name: string, lenient = false): Fn["run"] =>
  (args, call) => {
    const values = numbersOf(args, call, lenient);
    if (values instanceof XError) return values;
    // As one array: spread into arguments, a long column overflows the stack.
    return fromLibrary(libraryFunction(name)!(values));
  };
/** The middle number, or the mean of the middle two; formula.js's spreads its input. */
const median = (values: number[]) => {
  if (!values.length) return NUM;
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

function variance(values: number[], sample: boolean) {
  if (values.length < (sample ? 2 : 1)) return DIV0;
  const mean = sum(values) / values.length;
  return (
    values.reduce((total, value) => total + (value - mean) ** 2, 0) /
    (values.length - (sample ? 1 : 0))
  );
}
const stdev = (values: number[], sample: boolean) => {
  const result = variance(values, sample);
  return typeof result === "number" ? Math.sqrt(result) : result;
};

/** Every most frequent number, in the order each first appears, down one column. */
function modes(values: number[]): Value {
  const counts = new Map<number, number>();
  let most = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    most = Math.max(most, count);
  }
  if (most < 2) return NA;
  return new Grid([...counts].flatMap(([value, count]) => (count === most ? [[value]] : [])));
}

/** How many numbers each bin takes, smallest bin first, then those above every bin, down one column. */
function frequency(args: Value[], call: Call): Value {
  const data = numbersOf([args[0] ?? null], call);
  if (data instanceof XError) return data;
  const bins = numbersOf([args[1] ?? null], call);
  if (bins instanceof XError) return bins;
  const order = bins.map((_, index) => index).toSorted((a, b) => bins[a]! - bins[b]!);
  const counts = bins.map(() => 0).concat(0);
  for (const value of data) {
    const at = order.find((index) => value <= bins[index]!) ?? bins.length;
    counts[at] = counts[at]! + 1;
  }
  return new Grid(counts.map((count) => [count]));
}

/** Two-tailed chance two samples' variances differ this much; formula.js returns their ratio. */
function fTest(args: Value[], call: Call): Value {
  const first = numbersOf([args[0] ?? null], call);
  if (first instanceof XError) return first;
  const second = numbersOf([args[1] ?? null], call);
  if (second instanceof XError) return second;
  const [a, b] = [variance(first, true), variance(second, true)];
  if (a instanceof XError) return a;
  if (b instanceof XError) return b;
  if (a === 0 || b === 0) return DIV0;
  const below = fromLibrary(
    libraryFunction("F.DIST")!(a / b, first.length - 1, second.length - 1, true),
  );
  return typeof below === "number" ? 2 * Math.min(below, 1 - below) : below;
}

const numbersAmong = (items: Scalar[]) => items.filter((item) => typeof item === "number");
/** The t statistic and its degrees of freedom for T.TEST's type: paired, equal or unequal variances. */
function tStatistic(first: Scalar[], second: Scalar[], type: number) {
  if (type === 1) {
    if (first.length !== second.length) return NA;
    const differences = first.flatMap((item, at) => {
      const other = second[at];
      return typeof item === "number" && typeof other === "number" ? [item - other] : [];
    });
    const spread = variance(differences, true);
    if (spread instanceof XError) return spread;
    const n = differences.length;
    return { t: sum(differences) / n / Math.sqrt(spread / n), df: n - 1 };
  }
  const [a, b] = [numbersAmong(first), numbersAmong(second)];
  const [va, vb] = [variance(a, true), variance(b, true)];
  if (va instanceof XError) return va;
  if (vb instanceof XError) return vb;
  const gap = sum(a) / a.length - sum(b) / b.length;
  if (type === 2) {
    const df = a.length + b.length - 2;
    const pooled = ((a.length - 1) * va + (b.length - 1) * vb) / df;
    return { t: gap / Math.sqrt(pooled * (1 / a.length + 1 / b.length)), df };
  }
  const [ea, eb] = [va / a.length, vb / b.length];
  const df = (ea + eb) ** 2 / (ea ** 2 / (a.length - 1) + eb ** 2 / (b.length - 1));
  return { t: gap / Math.sqrt(ea + eb), df };
}
/** formula.js's T.TEST ignores its tails and type and always runs one unpaired test. */
function tTest(args: Value[]): Value {
  const tails = number(args[2]);
  if (tails instanceof XError) return tails;
  const type = number(args[3]);
  if (type instanceof XError) return type;
  const [t, k] = [Math.trunc(tails), Math.trunc(type)];
  if ((t !== 1 && t !== 2) || k < 1 || k > 3) return NUM;
  const [first, second] = [flat(args[0] ?? null), flat(args[1] ?? null)];
  const error = firstError([...first, ...second]);
  if (error) return error;
  const statistic = tStatistic(first, second, k);
  if (statistic instanceof XError) return statistic;
  if (!Number.isFinite(statistic.t)) return DIV0;
  const tail = fromLibrary(libraryFunction("T.DIST.RT")!(Math.abs(statistic.t), statistic.df));
  return typeof tail === "number" ? t * tail : tail;
}

/** Pearson's chi-squared test; formula.js rounds its result to six decimals. */
function chiSquareTest(args: Value[]): Value {
  const actual = gridOf(args[0] ?? null);
  if (actual instanceof XError) return actual;
  const expected = gridOf(args[1] ?? null);
  if (expected instanceof XError) return expected;
  const [rows, columns] = [actual.height, actual.width];
  if (rows !== expected.height || columns !== expected.width) return NA;
  const df = rows === 1 || columns === 1 ? rows * columns - 1 : (rows - 1) * (columns - 1);
  if (df < 1) return NA;
  let statistic = 0;
  for (const [r, row] of actual.rows.entries())
    for (const [c, seen] of row.entries()) {
      const wanted = expected.rows[r]![c] ?? null;
      if (seen instanceof XError) return seen;
      if (wanted instanceof XError) return wanted;
      if (typeof seen !== "number" || typeof wanted !== "number") continue;
      if (wanted === 0) return DIV0;
      statistic += (seen - wanted) ** 2 / wanted;
    }
  const below = fromLibrary(libraryFunction("CHISQ.DIST")!(statistic, df, true));
  return typeof below === "number" ? 1 - below : below;
}

/**
 * TREND and GROWTH in the shape of the x values asked about. formula.js returns a flat row,
 * and without new x values fits nothing; Excel then fits the known x values, or 1, 2, 3...
 */
const fitted = (name: "TREND" | "GROWTH"): Fn => ({
  kinds: "rrrs",
  run: (args, call) => {
    const knownY = args[0] ?? null;
    const ys = gridOf(knownY);
    if (ys instanceof XError) return ys;
    let count = 0;
    const knownX = call.omitted(1)
      ? new Grid(ys.rows.map((row) => row.map(() => ++count)))
      : args[1]!;
    const newX = call.omitted(2) ? knownX : args[2]!;
    const shape = gridOf(newX);
    if (shape instanceof XError) return shape;
    const constant = name === "GROWTH" && !call.omitted(3) ? [scalar(args[3])] : [];
    const result = fromLibrary(
      libraryFunction(name)!(toLibrary(knownY), toLibrary(knownX), toLibrary(newX), ...constant),
    );
    if (result instanceof XError) return result;
    const values = flat(result);
    if (values.length !== shape.height * shape.width) return VALUE;
    return new Grid(shape.rows.map((row, r) => row.map((_, c) => values[r * shape.width + c]!)));
  },
});

/** A square range of numbers as rows, or the error Excel gives for anything else. */
function squareOf(value: Value | undefined): number[][] | XError {
  const grid = gridOf(value ?? null);
  if (grid instanceof XError) return grid;
  if (grid.height !== grid.width) return VALUE;
  const error = firstError(grid.rows.flat());
  if (error) return error;
  if (grid.rows.some((row) => row.some((item) => typeof item !== "number"))) return VALUE;
  return grid.rows.map((row) => row.map(Number));
}
/** Gauss-Jordan elimination with the largest pivot: the determinant, and the inverse unless singular. */
function eliminate(matrix: number[][]) {
  const left = matrix.map((row) => [...row]);
  const right = matrix.map((row, r) => row.map((_, c): number => (r === c ? 1 : 0)));
  let determinant = 1;
  for (let at = 0; at < left.length; at++) {
    let pivot = at;
    for (let r = at + 1; r < left.length; r++)
      if (Math.abs(left[r]![at]!) > Math.abs(left[pivot]![at]!)) pivot = r;
    const lead = left[pivot]![at]!;
    if (lead === 0) return { determinant: 0, inverse: null };
    if (pivot !== at) {
      [left[at], left[pivot]] = [left[pivot]!, left[at]!];
      [right[at], right[pivot]] = [right[pivot]!, right[at]!];
      determinant = -determinant;
    }
    determinant *= lead;
    const [top, topRight] = [left[at]!.map((x) => x / lead), right[at]!.map((x) => x / lead)];
    [left[at], right[at]] = [top, topRight];
    for (let r = 0; r < left.length; r++) {
      const factor = left[r]![at]!;
      if (r === at || factor === 0) continue;
      left[r] = left[r]!.map((x, c) => x - factor * top[c]!);
      right[r] = right[r]!.map((x, c) => x - factor * topRight[c]!);
    }
  }
  return { determinant, inverse: right };
}

function countNumbers(args: Value[], call: Call) {
  let total = 0;
  for (const [index, arg] of args.entries()) {
    if (arg instanceof Grid || arg instanceof Areas) {
      for (const item of flat(arg)) if (typeof item === "number") total += 1;
    } else if (!call.omitted(index) && arg !== null && !(toNumber(arg) instanceof XError))
      total += 1;
  }
  return total;
}
function countA(args: Value[], call: Call) {
  let total = 0;
  for (const [index, arg] of args.entries()) {
    if (arg instanceof Grid || arg instanceof Areas) {
      for (const item of flat(arg)) if (item !== null) total += 1;
    } else if (!call.omitted(index)) total += 1;
  }
  return total;
}

/** A number list from the first argument and numeric parameters after it. */
const withParameters =
  (compute: (values: number[], ...parameters: number[]) => Value): Fn["run"] =>
  (args, call) => {
    const values = numbersOf([args[0] ?? null], call);
    if (values instanceof XError) return values;
    const parameters: number[] = [];
    for (let index = 1; index < args.length; index++) {
      if (call.omitted(index)) continue;
      const parameter = number(args[index]);
      if (parameter instanceof XError) return parameter;
      parameters.push(parameter);
    }
    return compute(values, ...parameters);
  };

const AGGREGATES: Record<number, (values: number[], k?: number) => Value> = {
  1: average,
  2: (values) => values.length,
  4: max,
  5: min,
  6: (values) => values.reduce((total, value) => total * value, 1),
  7: (values) => stdev(values, true),
  8: (values) => stdev(values, false),
  9: sum,
  10: (values) => variance(values, true),
  11: (values) => variance(values, false),
  12: median,
  13: (values) => fromLibrary(library.MODE.SNGL(values)),
  14: (values, k) => fromLibrary(library.LARGE(values, k)),
  15: (values, k) => fromLibrary(library.SMALL(values, k)),
  16: (values, k) => fromLibrary(library.PERCENTILE.INC(values, k)),
  17: (values, k) => fromLibrary(library.QUARTILE.INC(values, k)),
  18: (values, k) => fromLibrary(library.PERCENTILE.EXC(values, k)),
  19: (values, k) => fromLibrary(library.QUARTILE.EXC(values, k)),
};

function aggregate(code: number, refs: Value[], call: Call, skipErrors: boolean, k?: number) {
  if (code === 3) return countA(refs, call);
  if (code === 2) return countNumbers(refs, call);
  const compute = AGGREGATES[code];
  if (!compute) return VALUE;
  const values: number[] = [];
  for (const arg of refs)
    for (const item of flat(arg)) {
      if (item instanceof XError) {
        if (skipErrors) continue;
        return item;
      }
      if (typeof item === "number") values.push(item);
    }
  return compute(values, k);
}

// ---------------------------------------------------------------------------
// Criteria (SUMIF, COUNTIFS, ...)

/** A criterion as Excel reads it: "=x", ">5", "a*", "<>", a number or a boolean. */
export function criterion(wanted: Scalar): (value: Scalar) => boolean {
  if (typeof wanted === "number")
    return (value) =>
      (typeof value === "number" && round15(value) === round15(wanted)) ||
      (typeof value === "string" && parseNumberText(value) === wanted);
  if (typeof wanted === "boolean") return (value) => value === wanted;
  if (wanted instanceof XError)
    return (value) => value instanceof XError && value.code === wanted.code;
  const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(wanted ?? "")!;
  const op = match[1] ?? "";
  const operand = match[2]!;
  if (op === "" || op === "=" || op === "<>") {
    let test: (value: Scalar) => boolean;
    if (operand === "")
      test = op === "" ? (value) => value === null || value === "" : (value) => value === null;
    else {
      const numeric = parseNumberText(operand);
      const upper = operand.toUpperCase();
      if (numeric !== null)
        test = (value) =>
          (typeof value === "number" && round15(value) === round15(numeric)) ||
          (typeof value === "string" && parseNumberText(value) === numeric);
      else if (upper === "TRUE" || upper === "FALSE")
        test = (value) => value === (upper === "TRUE");
      else if (operand.startsWith("#"))
        test = (value) => value instanceof XError && value.code === upper;
      else {
        const pattern = wildcard(operand);
        test = (value) => typeof value === "string" && pattern.test(value);
      }
    }
    return op === "<>" ? (value) => !test(value) : test;
  }
  const ordered = (order: number) =>
    op === "<" ? order < 0 : op === ">" ? order > 0 : op === "<=" ? order <= 0 : order >= 0;
  const numeric = parseNumberText(operand);
  if (numeric !== null)
    return (value) => typeof value === "number" && ordered(compare(value, numeric));
  const upper = operand.toUpperCase();
  if (upper === "TRUE" || upper === "FALSE")
    return (value) => typeof value === "boolean" && ordered(compare(value, upper === "TRUE"));
  return (value) => typeof value === "string" && ordered(compare(value, operand));
}

/** A range argument's cells; a sum range as big as the criteria range it follows. */
function shaped(call: Call, value: Value, like: Grid): Grid | XError {
  if (!(value instanceof Grid)) return value instanceof Areas ? VALUE : new Grid([[value]]);
  if (!value.ref || (value.height === like.height && value.width === like.width)) return value;
  const { top, left } = value.ref.box;
  return call.cells({
    sheet: value.ref.sheet,
    box: { top, left, bottom: top + like.height - 1, right: left + like.width - 1 },
  });
}

/** The cells of `target` whose criteria all hold, pairs of (range, criterion) after it. */
function matching(call: Call, target: Value, pairs: Value[], resize: boolean): Scalar[] | XError {
  const first = pairs[0];
  if (!(first instanceof Grid)) return VALUE;
  const values = resize ? shaped(call, target, first) : target;
  if (values instanceof XError) return values;
  if (!(values instanceof Grid)) return VALUE;
  const tests: Array<{ grid: Grid; test: (value: Scalar) => boolean }> = [];
  for (let index = 0; index + 1 < pairs.length; index += 2) {
    const grid = pairs[index];
    if (!(grid instanceof Grid)) return VALUE;
    if (grid.height !== values.height || grid.width !== values.width) return VALUE;
    tests.push({ grid, test: criterion(scalar(pairs[index + 1])) });
  }
  const found: Scalar[] = [];
  values.rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (tests.every(({ grid, test }) => test(grid.rows[r]![c]!))) found.push(value);
    }),
  );
  return found;
}

const numbersIn = (values: Scalar[]): number[] | XError => {
  const found: number[] = [];
  for (const value of values) {
    if (value instanceof XError) return value;
    if (typeof value === "number") found.push(value);
  }
  return found;
};
const conditional =
  (compute: (values: number[]) => Value, form: "if" | "ifs"): Fn["run"] =>
  (args, call) => {
    const found =
      form === "if"
        ? matching(
            call,
            call.omitted(2) || args[2] === undefined ? args[0]! : args[2],
            [args[0]!, args[1] ?? null],
            true,
          )
        : matching(call, args[0]!, args.slice(1), false);
    if (found instanceof XError) return found;
    const values = numbersIn(found);
    return values instanceof XError ? values : compute(values);
  };

// ---------------------------------------------------------------------------
// Lookups

const sameType = (a: Scalar, b: Scalar) =>
  (typeof a === "number" && typeof b === "number") ||
  (typeof a === "string" && typeof b === "string") ||
  (typeof a === "boolean" && typeof b === "boolean");

/** Exact position of `wanted` in `list`: case-insensitive, wildcards in text unless disabled. */
function exactIndex(wanted: Scalar, list: readonly Scalar[], wildcards = true) {
  if (typeof wanted === "string" && wildcards && hasWildcard(wanted)) {
    const pattern = wildcard(wanted);
    return list.findIndex((item) => typeof item === "string" && pattern.test(item));
  }
  return list.findIndex((item) => sameType(item, wanted) && compare(item, wanted) === 0);
}
/** Largest item not above `wanted` in an ascending list (smallest not below, descending). */
function approximateIndex(wanted: Scalar, list: readonly Scalar[], descending = false) {
  let found = -1;
  for (const [index, item] of list.entries()) {
    if (!sameType(item, wanted)) continue;
    const order = compare(item, wanted);
    if (descending ? order < 0 : order > 0) break;
    found = index;
  }
  return found;
}

function lookupIn(args: Value[], call: Call, horizontal: boolean): Value {
  const wanted = scalar(args[0]);
  if (wanted instanceof XError) return wanted;
  const table = args[1];
  if (!(table instanceof Grid)) return VALUE;
  const index = number(args[2]);
  if (index instanceof XError) return index;
  const approximate = optionalBoolean(args, call, 3, true);
  if (approximate instanceof XError) return approximate;
  const pick = Math.trunc(index);
  if (pick < 1) return VALUE;
  const keys = horizontal ? table.rows[0]! : table.rows.map((row) => row[0]!);
  if (pick > (horizontal ? table.height : table.width)) return REF;
  const found = approximate ? approximateIndex(wanted, keys) : exactIndex(wanted, keys);
  if (found < 0) return NA;
  return horizontal ? table.rows[pick - 1]![found]! : table.rows[found]![pick - 1]!;
}

/** XMATCH's search: 0 exact, -1 exact or next smaller, 1 exact or next larger, 2 wildcard. */
function xmatch(wanted: Scalar, list: readonly Scalar[], mode: number, search: number) {
  const order = search < 0 || search === -2 ? [...list.keys()].toReversed() : [...list.keys()];
  if (mode === 2) {
    if (typeof wanted !== "string")
      return (
        order.find(
          (index) => compare(list[index]!, wanted) === 0 && sameType(list[index]!, wanted),
        ) ?? -1
      );
    const pattern = wildcard(wanted);
    return (
      order.find(
        (index) => typeof list[index] === "string" && pattern.test(list[index] as string),
      ) ?? -1
    );
  }
  const exact = order.find(
    (index) => sameType(list[index]!, wanted) && compare(list[index]!, wanted) === 0,
  );
  if (exact !== undefined || mode === 0) return exact ?? -1;
  let best = -1;
  for (const index of order) {
    const item = list[index]!;
    if (!sameType(item, wanted)) continue;
    const order2 = compare(item, wanted);
    if (mode === -1 && order2 < 0 && (best === -1 || compare(item, list[best]!) > 0)) best = index;
    if (mode === 1 && order2 > 0 && (best === -1 || compare(item, list[best]!) < 0)) best = index;
  }
  return best;
}

/** Part of a range, as a reference when it came from one. */
function partOf(call: Call, grid: Grid, box: CellBox): Grid {
  if (grid.ref) {
    const { top, left } = grid.ref.box;
    return call.cells({
      sheet: grid.ref.sheet,
      box: {
        top: top + box.top,
        left: left + box.left,
        bottom: top + box.bottom,
        right: left + box.right,
      },
    });
  }
  return new Grid(
    grid.rows.slice(box.top, box.bottom + 1).map((row) => row.slice(box.left, box.right + 1)),
  );
}
const heightOf = (grid: Grid) =>
  grid.ref ? grid.ref.box.bottom - grid.ref.box.top + 1 : grid.height;
const widthOf = (grid: Grid) =>
  grid.ref ? grid.ref.box.right - grid.ref.box.left + 1 : grid.width;

function indexInto(args: Value[], call: Call): Value {
  let source = args[0];
  if (source instanceof Areas) {
    const area = optionalNumber(args, call, 3, 1);
    if (area instanceof XError) return area;
    source = source.grids[Math.trunc(area) - 1];
    if (!source) return REF;
  }
  if (!(source instanceof Grid)) source = new Grid([[scalar(source ?? null)]]);
  const height = heightOf(source);
  const width = widthOf(source);
  const rowArg = optionalNumber(args, call, 1, 0);
  const columnArg = optionalNumber(args, call, 2, 0);
  if (rowArg instanceof XError) return rowArg;
  if (columnArg instanceof XError) return columnArg;
  let row = Math.trunc(rowArg);
  let column = Math.trunc(columnArg);
  // One index into a single row or column picks along it.
  if ((call.omitted(2) || args[2] === undefined) && height === 1 && width > 1)
    [row, column] = [1, row];
  if (row < 0 || column < 0 || row > height || column > width) return REF;
  const box = {
    top: row ? row - 1 : 0,
    bottom: row ? row - 1 : height - 1,
    left: column ? column - 1 : 0,
    right: column ? column - 1 : width - 1,
  };
  return partOf(call, source, box);
}

// ---------------------------------------------------------------------------
// Dynamic arrays

const gridOf = (value: Value): Grid | XError =>
  value instanceof Areas ? VALUE : value instanceof Grid ? value : new Grid([[value]]);
const transpose = (grid: Grid) =>
  new Grid(Array.from({ length: grid.width }, (_, c) => grid.rows.map((row) => row[c] ?? null)));
/** Sorting puts blanks last whatever the order, and errors after everything else. */
const sortCompare = (a: Scalar, b: Scalar) => {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (a instanceof XError || b instanceof XError)
    return a instanceof XError && b instanceof XError ? 0 : a instanceof XError ? 1 : -1;
  return compare(a, b);
};
const rowKey = (row: readonly Scalar[]) =>
  JSON.stringify(
    row.map((item) =>
      item instanceof XError
        ? { e: item.code }
        : typeof item === "string"
          ? item.toLowerCase()
          : typeof item === "number"
            ? round15(item)
            : item,
    ),
  );
const emptyAsZero = (grid: Grid) =>
  new Grid(grid.rows.map((row) => row.map((item) => (item === null ? 0 : item))));

function sortRows(grid: Grid, keys: Array<{ values: Scalar[]; order: number }>) {
  const order = [...grid.rows.keys()].toSorted((a, b) => {
    for (const key of keys) {
      const result = sortCompare(key.values[a]!, key.values[b]!);
      if (result)
        return key.values[a] === null || key.values[b] === null ? result : result * key.order;
    }
    return 0;
  });
  return new Grid(order.map((index) => grid.rows[index]!));
}

function stack(args: Value[], horizontal: boolean): Value {
  let parts: Grid[] = [];
  for (const arg of args) {
    const grid = gridOf(arg);
    if (grid instanceof XError) return grid;
    parts.push(grid);
  }
  if (horizontal) parts = parts.map(transpose);
  const width = Math.max(...parts.map((grid) => grid.width));
  const rows = parts.flatMap((grid) =>
    grid.rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => NA)]),
  );
  const result = new Grid(rows);
  return horizontal ? transpose(result) : result;
}

function pickLines(grid: Grid, picks: Value[], columns: boolean): Value {
  const source = columns ? transpose(grid) : grid;
  const lines: Scalar[][] = [];
  for (const pick of picks) {
    const at = number(pick);
    if (at instanceof XError) return at;
    const line = Math.trunc(at);
    const found = source.rows[line > 0 ? line - 1 : source.height + line];
    if (!line || !found) return VALUE;
    lines.push(found);
  }
  const result = new Grid(lines);
  return columns ? transpose(result) : result;
}

function takeOrDrop(args: Value[], call: Call, take: boolean): Value {
  const grid = gridOf(args[0] ?? null);
  if (grid instanceof XError) return grid;
  const rows = optionalNumber(args, call, 1, take ? grid.height : 0);
  const columns = optionalNumber(args, call, 2, take ? grid.width : 0);
  if (rows instanceof XError) return rows;
  if (columns instanceof XError) return columns;
  const span = (count: number, size: number): [number, number] => {
    const n = Math.min(Math.abs(Math.trunc(count)), size);
    if (take) return count >= 0 ? [0, n] : [size - n, size];
    return count >= 0 ? [n, size] : [0, size - n];
  };
  const [top, bottom] = span(rows, grid.height);
  const [left, right] = span(columns, grid.width);
  if (bottom <= top || right <= left) return CALC;
  return new Grid(grid.rows.slice(top, bottom).map((row) => row.slice(left, right)));
}

// ---------------------------------------------------------------------------
// Text

/** A value in a number format, as Excel's TEXT writes it (US English); null where Excel gives #VALUE!. */
const formatted = (value: number | string, format: string) =>
  formatValue(value, format)?.text ?? null;

/** Rounds half away from zero at `digits` places, as Excel's ROUND does. */
function roundTo(value: number, digits: number) {
  const factor = 10 ** Math.trunc(digits);
  const scaled = round15(Math.abs(value) * factor);
  return (Math.sign(value) * Math.round(scaled)) / factor;
}

function fixed(value: number, digits: number, commas: boolean) {
  const rounded = roundTo(value, digits);
  const places = Math.max(0, Math.trunc(digits));
  const code = `${commas ? "#,##0" : "0"}${places ? `.${"0".repeat(places)}` : ""}`;
  return formatted(rounded, code)!;
}

function textAround(args: Value[], call: Call, after: boolean): Value {
  const whole = text(args[0]);
  const delimiter = text(args[1]);
  if (whole instanceof XError) return whole;
  if (delimiter instanceof XError) return delimiter;
  const instance = optionalNumber(args, call, 2, 1);
  const mode = optionalNumber(args, call, 3, 0);
  if (instance instanceof XError) return instance;
  if (mode instanceof XError) return mode;
  const n = Math.trunc(instance);
  if (!n || Math.abs(n) > whole.length + 1) return VALUE;
  if (delimiter === "") return n > 0 ? (after ? whole : "") : after ? "" : whole;
  const haystack = mode === 1 ? whole.toLowerCase() : whole;
  const needle = mode === 1 ? delimiter.toLowerCase() : delimiter;
  const positions: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at >= 0;
    at = haystack.indexOf(needle, at + needle.length)
  )
    positions.push(at);
  const at = n > 0 ? positions[n - 1] : positions[positions.length + n];
  if (at === undefined) return call.omitted(5) || args[5] === undefined ? NA : scalar(args[5]);
  return after ? whole.slice(at + delimiter.length) : whole.slice(0, at);
}

// ---------------------------------------------------------------------------
// formula.js

type Library = Record<string, unknown>;
// A namespace import is an object of its exports, so it widens without narrowing.
const libraryTable: Library = { ...library };
/** Excel's legacy names formula.js keeps only under their current name. */
const LIBRARY_ALIASES = new Map([["PERCENTRANK", "PERCENTRANK.INC"]]);
/** "STDEV.S" lives at library.STDEV.S; a plain name at the top. */
export function libraryFunction(name: string): ((...args: unknown[]) => unknown) | null {
  const found = (LIBRARY_ALIASES.get(name) ?? name)
    .split(".")
    .reduce<unknown>((node, part) => (node as Library | undefined)?.[part], libraryTable);
  return typeof found === "function" ? (found as (...args: unknown[]) => unknown) : null;
}

/** Days from Excel's 1900 epoch (as Excel counts it) to the Unix epoch. */
const EXCEL_UNIX_DAYS = 25_569;
const MS_PER_DAY = 86_400_000;
export const toLibrary = (value: Value): unknown =>
  value instanceof Areas
    ? value.grids.flatMap((grid) => grid.rows.map((row) => row.map(toLibrary)))
    : value instanceof Grid
      ? value.rows.map((row) => row.map(toLibrary))
      : value instanceof XError
        ? new Error(value.code)
        : value;
export function fromLibrary(result: unknown): Value {
  if (result instanceof Error)
    return new XError(/^#[A-Z0-9/!?]+$/.test(result.message) ? result.message : "#VALUE!");
  // formula.js builds dates from local calendar fields; reading them back the
  // same way keeps a date's serial independent of the server's time zone.
  if (result instanceof Date)
    return Number.isNaN(result.getTime())
      ? VALUE
      : Date.UTC(
          result.getFullYear(),
          result.getMonth(),
          result.getDate(),
          result.getHours(),
          result.getMinutes(),
          result.getSeconds(),
          result.getMilliseconds(),
        ) /
          MS_PER_DAY +
          EXCEL_UNIX_DAYS;
  if (typeof result === "number") return Number.isFinite(result) ? result : NUM;
  if (typeof result === "string" || typeof result === "boolean") return result;
  if (result === null || result === undefined) return 0;
  if (Array.isArray(result)) {
    const rows = (Array.isArray(result[0]) ? result : [result]) as unknown[][];
    return new Grid(rows.map((row) => row.map((item) => scalar(fromLibrary(item)))));
  }
  return VALUE;
}

/** Which formula.js functions take ranges, by argument (kinds as above). */
export const LIBRARY_KINDS: Record<string, string> = {
  CORREL: "rr",
  "COVARIANCE.P": "rr",
  "COVARIANCE.S": "rr",
  COVAR: "rr",
  PEARSON: "rr",
  RSQ: "rr",
  SLOPE: "rr",
  INTERCEPT: "rr",
  STEYX: "rr",
  FORECAST: "srr",
  "FORECAST.LINEAR": "srr",
  NPV: "s|r",
  MIRR: "rss",
  XNPV: "srr",
  XIRR: "rrs",
  MMULT: "rr",
  SUMX2MY2: "rr",
  SUMX2PY2: "rr",
  SUMXMY2: "rr",
  LINEST: "rrss",
  LOGEST: "rrss",
  "PERCENTRANK.INC": "rss",
  "PERCENTRANK.EXC": "rss",
  PERCENTRANK: "rss",
  PROB: "rrss",
  TRIMMEAN: "rs",
  "Z.TEST": "rss",
  SERIESSUM: "sssr",
};
/** formula.js functions whose array arguments are numbers only, as Excel reads them. */
export const LIBRARY_NUMBERS = new Set(["NPV", "MIRR", "TRIMMEAN"]);

// ---------------------------------------------------------------------------
// The table

const is = (test: (value: Scalar) => boolean): Fn => ({
  errors: true,
  run: (args) => test(scalar(args[0])),
});
const ERROR_TYPES: Record<string, number> = {
  "#NULL!": 1,
  "#DIV/0!": 2,
  "#VALUE!": 3,
  "#REF!": 4,
  "#NAME?": 5,
  "#NUM!": 6,
  "#N/A": 7,
  "#GETTING_DATA": 8,
  "#SPILL!": 9,
  "#CALC!": 14,
};
const truthOf = (args: Value[], call: Call, combine: (values: boolean[]) => boolean): Value => {
  const values: boolean[] = [];
  for (const [index, arg] of args.entries()) {
    if (arg instanceof Grid || arg instanceof Areas) {
      for (const item of flat(arg)) {
        if (item instanceof XError) return item;
        if (typeof item === "boolean") values.push(item);
        else if (typeof item === "number") values.push(item !== 0);
      }
      continue;
    }
    if (call.omitted(index) || arg === null) continue;
    const truth = toBoolean(arg);
    if (truth instanceof XError) return truth;
    values.push(truth);
  }
  return values.length ? combine(values) : VALUE;
};
const dateParts = (args: Value[]) => {
  const serial = number(args[0]);
  if (serial instanceof XError) return serial;
  return partsOf(serial) ?? NUM;
};
const ofDate = (pick: (parts: NonNullable<ReturnType<typeof partsOf>>) => number): Fn => ({
  run: (args) => {
    const parts = dateParts(args);
    return parts instanceof XError ? parts : pick(parts);
  },
});
const ofClock = (pick: (clock: ReturnType<typeof clockOf>) => number): Fn => ({
  run: (args) => {
    const serial = number(args[0]);
    if (serial instanceof XError) return serial;
    return serial < 0 ? NUM : pick(clockOf(serial));
  },
});

/** Holidays as serials from any range or array: formula.js reads a list of rows as no dates at all. */
function holidaysOf(value: Value | undefined): number[] | XError {
  const serials: number[] = [];
  for (const item of value === undefined ? [] : flat(value)) {
    if (item === null) continue;
    const serial = toNumber(item);
    if (serial instanceof XError) return serial;
    serials.push(serial);
  }
  return serials;
}
/** NETWORKDAYS and WORKDAY, with or without a weekend argument, through formula.js's INTL forms. */
const workdays = (name: "NETWORKDAYS" | "WORKDAY", intl: boolean): Fn => ({
  kinds: intl ? "sssr" : "ssr",
  run: (args, call) => {
    const start = number(args[0]);
    if (start instanceof XError) return start;
    const second = number(args[1]);
    if (second instanceof XError) return second;
    const weekend = intl && !call.omitted(2) ? scalar(args[2]) : 1;
    // formula.js reads 0 as no weekend at all; Excel takes only codes 1 to 7 and 11 to 17.
    if (
      typeof weekend === "number" &&
      !((weekend >= 1 && weekend <= 7) || (weekend >= 11 && weekend <= 17))
    )
      return NUM;
    const holidaysAt = intl ? 3 : 2;
    const holidays = holidaysOf(call.omitted(holidaysAt) ? undefined : args[holidaysAt]);
    if (holidays instanceof XError) return holidays;
    const run = libraryFunction(`${name}.INTL`)!;
    // formula.js counts a backward span as minus its length plus one; Excel negates the forward count.
    if (name === "NETWORKDAYS" && second < start) {
      const forward = fromLibrary(run(second, start, weekend, holidays));
      return typeof forward === "number" ? -forward : forward;
    }
    return fromLibrary(run(start, second, weekend, holidays));
  },
});

export const FUNCTIONS: Record<string, Fn> = {
  SUM: { kinds: "|r", run: onNumbers(sum) },
  PRODUCT: {
    kinds: "|r",
    run: onNumbers((values) =>
      values.length ? values.reduce((total, value) => total * value, 1) : 0,
    ),
  },
  SUMSQ: { kinds: "|r", run: onNumbers((values) => sum(values.map((value) => value * value))) },
  AVERAGE: { kinds: "|r", run: onNumbers(average) },
  AVERAGEA: { kinds: "|r", run: onNumbers(average, true) },
  MAX: { kinds: "|r", run: onNumbers(max) },
  MAXA: { kinds: "|r", run: onNumbers(max, true) },
  MIN: { kinds: "|r", run: onNumbers(min) },
  MINA: { kinds: "|r", run: onNumbers(min, true) },
  "STDEV.S": { kinds: "|r", run: onNumbers((values) => stdev(values, true)) },
  STDEV: { kinds: "|r", run: onNumbers((values) => stdev(values, true)) },
  "STDEV.P": { kinds: "|r", run: onNumbers((values) => stdev(values, false)) },
  STDEVP: { kinds: "|r", run: onNumbers((values) => stdev(values, false)) },
  STDEVA: { kinds: "|r", run: onNumbers((values) => stdev(values, true), true) },
  STDEVPA: { kinds: "|r", run: onNumbers((values) => stdev(values, false), true) },
  "VAR.S": { kinds: "|r", run: onNumbers((values) => variance(values, true)) },
  VAR: { kinds: "|r", run: onNumbers((values) => variance(values, true)) },
  "VAR.P": { kinds: "|r", run: onNumbers((values) => variance(values, false)) },
  VARP: { kinds: "|r", run: onNumbers((values) => variance(values, false)) },
  VARA: { kinds: "|r", run: onNumbers((values) => variance(values, true), true) },
  VARPA: { kinds: "|r", run: onNumbers((values) => variance(values, false), true) },
  MEDIAN: {
    kinds: "|r",
    run: (args, call) => {
      const values = numbersOf(args, call);
      return values instanceof XError ? values : median(values);
    },
  },
  MODE: { kinds: "|r", run: libraryStat("MODE.SNGL") },
  "MODE.SNGL": { kinds: "|r", run: libraryStat("MODE.SNGL") },
  "MODE.MULT": { kinds: "|r", run: onNumbers(modes) },
  "F.TEST": { kinds: "rr", run: fTest },
  "CHISQ.TEST": { kinds: "rr", run: chiSquareTest },
  MDETERM: {
    kinds: "r",
    run: (args) => {
      const matrix = squareOf(args[0]);
      return matrix instanceof XError ? matrix : eliminate(matrix).determinant;
    },
  },
  MINVERSE: {
    kinds: "r",
    run: (args) => {
      const matrix = squareOf(args[0]);
      if (matrix instanceof XError) return matrix;
      const { inverse } = eliminate(matrix);
      return inverse ? new Grid(inverse) : NUM;
    },
  },
  TREND: fitted("TREND"),
  GROWTH: fitted("GROWTH"),
  "T.TEST": { kinds: "rrss", run: tTest },
  FREQUENCY: { kinds: "rr", run: frequency },
  GEOMEAN: { kinds: "|r", run: libraryStat("GEOMEAN") },
  HARMEAN: { kinds: "|r", run: libraryStat("HARMEAN") },
  AVEDEV: { kinds: "|r", run: libraryStat("AVEDEV") },
  DEVSQ: { kinds: "|r", run: libraryStat("DEVSQ") },
  KURT: { kinds: "|r", run: libraryStat("KURT") },
  SKEW: { kinds: "|r", run: libraryStat("SKEW") },
  "SKEW.P": { kinds: "|r", run: libraryStat("SKEW.P") },
  LARGE: {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.LARGE(values, k))),
  },
  SMALL: {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.SMALL(values, k))),
  },
  PERCENTILE: {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.PERCENTILE.INC(values, k))),
  },
  "PERCENTILE.INC": {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.PERCENTILE.INC(values, k))),
  },
  "PERCENTILE.EXC": {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.PERCENTILE.EXC(values, k))),
  },
  QUARTILE: {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.QUARTILE.INC(values, k))),
  },
  "QUARTILE.INC": {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.QUARTILE.INC(values, k))),
  },
  "QUARTILE.EXC": {
    kinds: "rs",
    run: withParameters((values, k = NaN) => fromLibrary(library.QUARTILE.EXC(values, k))),
  },
  RANK: { kinds: "srs", run: (args, call) => rank(args, call, false) },
  "RANK.EQ": { kinds: "srs", run: (args, call) => rank(args, call, false) },
  "RANK.AVG": { kinds: "srs", run: (args, call) => rank(args, call, true) },
  COUNT: { kinds: "|r", run: countNumbers },
  COUNTA: { kinds: "|r", run: countA },
  COUNTBLANK: {
    kinds: "r",
    run: (args) => flat(args[0] ?? null).filter((item) => item === null || item === "").length,
  },
  SUMPRODUCT: {
    kinds: "|a",
    errors: true,
    run: (args) => {
      const parts = args.map(gridOf);
      const bad = parts.find((item) => item instanceof XError);
      if (bad) return bad;
      const shapes = parts as Grid[];
      const [first] = shapes;
      if (!first) return VALUE;
      if (shapes.some((grid) => grid.height !== first.height || grid.width !== first.width))
        return VALUE;
      let total = 0;
      for (let r = 0; r < first.height; r++)
        for (let c = 0; c < first.width; c++) {
          let product = 1;
          for (const grid of shapes) {
            const item = grid.rows[r]![c]!;
            if (item instanceof XError) return item;
            product *= typeof item === "number" ? item : 0;
          }
          total += product;
        }
      return total;
    },
  },
  SUBTOTAL: {
    kinds: "s|r",
    run: (args, call) => {
      const code = number(args[0]);
      if (code instanceof XError) return code;
      const which = Math.trunc(code) % 100;
      return which >= 1 && which <= 11 ? aggregate(which, args.slice(1), call, false) : VALUE;
    },
  },
  AGGREGATE: {
    kinds: "ss|r",
    run: (args, call) => {
      const code = number(args[0]);
      const options = number(args[1]);
      if (code instanceof XError) return code;
      if (options instanceof XError) return options;
      const which = Math.trunc(code);
      const skipErrors = [2, 3, 6, 7].includes(Math.trunc(options));
      if (which >= 14) {
        const k = number(args[3]);
        return k instanceof XError ? k : aggregate(which, [args[2] ?? null], call, skipErrors, k);
      }
      return aggregate(which, args.slice(2), call, skipErrors);
    },
  },
  BASE: {
    run: (args, call) => {
      const values = [number(args[0]), number(args[1]), optionalNumber(args, call, 2, 0)];
      const bad = values.find((value) => value instanceof XError);
      if (bad !== undefined) return bad;
      const [value, radix, length] = values as number[];
      if (value! < 0 || value! >= 2 ** 53 || radix! < 2 || radix! > 36 || length! < 0) return NUM;
      return Math.trunc(value!)
        .toString(Math.trunc(radix!))
        .toUpperCase()
        .padStart(Math.trunc(length!), "0");
    },
  },
  "FORECAST.LINEAR": {
    kinds: "srr",
    run: (args) => {
      const error = firstError([
        scalar(args[0]),
        ...flat(args[1] ?? null),
        ...flat(args[2] ?? null),
      ]);
      return (
        error ??
        fromLibrary(
          library.FORECAST(
            toLibrary(args[0] ?? null),
            toLibrary(args[1] ?? null),
            toLibrary(args[2] ?? null),
          ),
        )
      );
    },
  },
  // Newton's method from the guess, 20 steps at most, as Excel iterates it: its result is this one's to the last digit.
  IRR: {
    kinds: "rs",
    run: (args, call) => {
      const flows = numbersOf([args[0] ?? null], call);
      if (flows instanceof XError) return flows;
      const guess = optionalNumber(args, call, 1, 0.1);
      if (guess instanceof XError) return guess;
      if (!flows.some((flow) => flow > 0) || !flows.some((flow) => flow < 0)) return NUM;
      let rate = guess;
      for (let step = 0; step < 20; step++) {
        let value = 0;
        let slope = 0;
        flows.forEach((flow, at) => {
          value += flow / (1 + rate) ** at;
          slope -= (at * flow) / (1 + rate) ** (at + 1);
        });
        if (!slope || !Number.isFinite(slope)) return NUM;
        const next = rate - value / slope;
        if (!Number.isFinite(next)) return NUM;
        if (Math.abs(next - rate) < 1e-10) return next;
        rate = next;
      }
      return NUM;
    },
  },
  MOD: {
    run: (args) => {
      const n = number(args[0]);
      const d = number(args[1]);
      if (n instanceof XError) return n;
      if (d instanceof XError) return d;
      if (d === 0) return DIV0;
      return round15(n - d * Math.floor(n / d));
    },
  },
  ROUND: {
    run: (args) => {
      const n = number(args[0]);
      const digits = number(args[1]);
      if (n instanceof XError) return n;
      if (digits instanceof XError) return digits;
      return roundTo(n, digits);
    },
  },

  SUMIF: { kinds: "rsr", run: conditional(sum, "if") },
  SUMIFS: { kinds: "r|rs", run: conditional(sum, "ifs") },
  AVERAGEIF: { kinds: "rsr", run: conditional(average, "if") },
  AVERAGEIFS: { kinds: "r|rs", run: conditional(average, "ifs") },
  MAXIFS: { kinds: "r|rs", run: conditional(max, "ifs") },
  MINIFS: { kinds: "r|rs", run: conditional(min, "ifs") },
  COUNTIF: {
    kinds: "rs",
    run: (args, call) => {
      const found = matching(call, args[0]!, [args[0]!, args[1] ?? null], false);
      return found instanceof XError ? found : found.length;
    },
  },
  COUNTIFS: {
    kinds: "|rs",
    run: (args, call) => {
      const found = matching(call, args[0]!, args, false);
      return found instanceof XError ? found : found.length;
    },
  },

  AND: { kinds: "|r", run: (args, call) => truthOf(args, call, (values) => values.every(Boolean)) },
  OR: { kinds: "|r", run: (args, call) => truthOf(args, call, (values) => values.some(Boolean)) },
  XOR: {
    kinds: "|r",
    run: (args, call) => truthOf(args, call, (values) => values.filter(Boolean).length % 2 === 1),
  },
  NOT: {
    run: (args) => {
      const truth = toBoolean(scalar(args[0]));
      return truth instanceof XError ? truth : !truth;
    },
  },
  TRUE: { run: () => true },
  FALSE: { run: () => false },
  NA: { run: () => NA },

  VLOOKUP: { kinds: "srss", run: (args, call) => lookupIn(args, call, false) },
  HLOOKUP: { kinds: "srss", run: (args, call) => lookupIn(args, call, true) },
  MATCH: {
    kinds: "srs",
    run: (args, call) => {
      const wanted = scalar(args[0]);
      if (wanted instanceof XError) return wanted;
      if (args[1] instanceof XError) return args[1];
      const list = vector(args[1] ?? null);
      if (!list) return NA;
      const type = optionalNumber(args, call, 2, 1);
      if (type instanceof XError) return type;
      const found =
        type === 0 ? exactIndex(wanted, list) : approximateIndex(wanted, list, type < 0);
      return found < 0 ? NA : found + 1;
    },
  },
  XMATCH: {
    kinds: "srss",
    run: (args, call) => {
      const wanted = scalar(args[0]);
      if (wanted instanceof XError) return wanted;
      const list = vector(args[1] ?? null);
      if (!list) return VALUE;
      const mode = optionalNumber(args, call, 2, 0);
      const search = optionalNumber(args, call, 3, 1);
      if (mode instanceof XError) return mode;
      if (search instanceof XError) return search;
      const found = xmatch(wanted, list, mode, search);
      return found < 0 ? NA : found + 1;
    },
  },
  XLOOKUP: {
    kinds: "srrrss",
    run: (args, call) => {
      const wanted = scalar(args[0]);
      if (wanted instanceof XError) return wanted;
      const list = vector(args[1] ?? null);
      if (!list) return VALUE;
      const mode = optionalNumber(args, call, 4, 0);
      const search = optionalNumber(args, call, 5, 1);
      if (mode instanceof XError) return mode;
      if (search instanceof XError) return search;
      const found = xmatch(wanted, list, mode, search);
      if (found < 0) return call.omitted(3) || args[3] === undefined ? NA : args[3]!;
      const results = args[2];
      if (!(results instanceof Grid)) return results ?? NA;
      // A row of results for a vertical lookup, a column for a horizontal one.
      const vertical = heightOf(results) === list.length && list.length > 1;
      return vertical
        ? partOf(call, results, { top: found, bottom: found, left: 0, right: widthOf(results) - 1 })
        : partOf(call, results, {
            top: 0,
            bottom: heightOf(results) - 1,
            left: found,
            right: found,
          });
    },
  },
  LOOKUP: {
    kinds: "srr",
    run: (args, call) => {
      const wanted = scalar(args[0]);
      if (wanted instanceof XError) return wanted;
      const source = gridOf(args[1] ?? null);
      if (source instanceof XError) return source;
      let keys: Scalar[];
      let results: Scalar[];
      if (call.omitted(2) || args[2] === undefined) {
        const wide = source.width > source.height;
        keys = wide ? source.rows[0]! : source.rows.map((row) => row[0]!);
        results = wide ? source.rows.at(-1)! : source.rows.map((row) => row.at(-1)!);
      } else {
        keys = vector(source) ?? [];
        results = vector(args[2]!) ?? [];
      }
      const found = approximateIndex(wanted, keys);
      return found < 0 ? NA : (results[found] ?? NA);
    },
  },
  INDEX: { kinds: "rsss", run: indexInto },
  ROW: {
    kinds: "r",
    run: (args, call) => {
      if (call.omitted(0) || args[0] === undefined) return call.row;
      const ref = args[0] instanceof Grid ? args[0].ref : null;
      if (!ref) return VALUE;
      const { top, bottom } = ref.box;
      return top === bottom
        ? top
        : new Grid(Array.from({ length: bottom - top + 1 }, (_, i) => [top + i]));
    },
  },
  COLUMN: {
    kinds: "r",
    run: (args, call) => {
      if (call.omitted(0) || args[0] === undefined) return call.column;
      const ref = args[0] instanceof Grid ? args[0].ref : null;
      if (!ref) return VALUE;
      const { left, right } = ref.box;
      return left === right
        ? left
        : new Grid([Array.from({ length: right - left + 1 }, (_, i) => left + i)]);
    },
  },
  ROWS: {
    kinds: "r",
    run: (args) => {
      const arg = args[0] ?? null;
      return arg instanceof Areas ? REF : arg instanceof Grid ? heightOf(arg) : 1;
    },
  },
  COLUMNS: {
    kinds: "r",
    run: (args) => {
      const arg = args[0] ?? null;
      return arg instanceof Areas ? REF : arg instanceof Grid ? widthOf(arg) : 1;
    },
  },
  AREAS: { kinds: "r", run: (args) => (args[0] instanceof Areas ? args[0].grids.length : 1) },
  OFFSET: {
    kinds: "rssss",
    run: (args, call) => {
      const base = args[0];
      if (!(base instanceof Grid) || !base.ref) return VALUE;
      const rows = number(args[1]);
      const columns = number(args[2]);
      if (rows instanceof XError) return rows;
      if (columns instanceof XError) return columns;
      const height = optionalNumber(args, call, 3, heightOf(base));
      const width = optionalNumber(args, call, 4, widthOf(base));
      if (height instanceof XError) return height;
      if (width instanceof XError) return width;
      if (Math.trunc(height) < 1 || Math.trunc(width) < 1) return REF;
      const top = base.ref.box.top + Math.trunc(rows);
      const left = base.ref.box.left + Math.trunc(columns);
      const box = {
        top,
        left,
        bottom: top + Math.trunc(height) - 1,
        right: left + Math.trunc(width) - 1,
      };
      if (box.top < 1 || box.left < 1 || box.bottom > 1_048_576 || box.right > 16_384) return REF;
      return call.cells({ sheet: base.ref.sheet, box });
    },
  },
  INDIRECT: {
    run: (args, call) => {
      const reference = text(args[0]);
      if (reference instanceof XError) return reference;
      const a1 = optionalBoolean(args, call, 1, true);
      if (a1 instanceof XError) return a1;
      return call.reference(reference, a1) ?? REF;
    },
  },
  // A1# in Excel: the whole range a dynamic formula spilled into.
  ANCHORARRAY: {
    kinds: "r",
    run: (args, call) => {
      const ref = args[0] instanceof Grid ? args[0].ref : null;
      if (!ref) return VALUE;
      const box = call.spill(ref.sheet, ref.box.top, ref.box.left);
      return box ? call.cells({ sheet: ref.sheet, box }) : REF;
    },
  },
  SINGLE: {
    kinds: "r",
    run: (args, call) => {
      const arg = args[0] ?? null;
      if (!(arg instanceof Grid)) return scalar(arg);
      if (!arg.ref) return arg.rows[0]?.[0] ?? null;
      const { box } = arg.ref;
      const row = box.top === box.bottom ? box.top : call.row;
      const column = box.left === box.right ? box.left : call.column;
      if (row < box.top || row > box.bottom || column < box.left || column > box.right)
        return VALUE;
      return call.cells({
        sheet: arg.ref.sheet,
        box: { top: row, bottom: row, left: column, right: column },
      }).rows[0]![0]!;
    },
  },
  TRANSPOSE: {
    kinds: "v",
    run: (args) => {
      const grid = gridOf(args[0] ?? null);
      return grid instanceof XError ? grid : transpose(emptyAsZero(grid));
    },
  },
  SORT: {
    kinds: "rsss",
    run: (args, call) => {
      const grid = gridOf(args[0] ?? null);
      if (grid instanceof XError) return grid;
      const at = optionalNumber(args, call, 1, 1);
      const order = optionalNumber(args, call, 2, 1);
      const byColumn = optionalBoolean(args, call, 3, false);
      if (at instanceof XError) return at;
      if (order instanceof XError) return order;
      if (byColumn instanceof XError) return byColumn;
      const source = byColumn ? transpose(grid) : grid;
      const key = Math.trunc(at) - 1;
      if (key < 0 || key >= source.width || (order !== 1 && order !== -1)) return VALUE;
      const sorted = sortRows(emptyAsZero(source), [
        { values: source.rows.map((row) => (row[key] === null ? 0 : row[key]!)), order },
      ]);
      return byColumn ? transpose(sorted) : sorted;
    },
  },
  SORTBY: {
    kinds: "r|rs",
    run: (args) => {
      const grid = gridOf(args[0] ?? null);
      if (grid instanceof XError) return grid;
      const keys: Array<{ values: Scalar[]; order: number }> = [];
      for (let at = 1; at < args.length; at += 2) {
        const values = vector(args[at]!);
        if (!values || values.length !== grid.height) return VALUE;
        const order = args[at + 1] === undefined ? 1 : number(args[at + 1]);
        if (order instanceof XError) return order;
        keys.push({ values, order });
      }
      return sortRows(emptyAsZero(grid), keys);
    },
  },
  FILTER: {
    kinds: "rar",
    run: (args, call) => {
      const grid = gridOf(args[0] ?? null);
      if (grid instanceof XError) return grid;
      const include = gridOf(args[1] ?? null);
      if (include instanceof XError) return include;
      const byRow = include.width === 1 && include.height === grid.height;
      const byColumn = include.height === 1 && include.width === grid.width;
      if (!byRow && !byColumn) return VALUE;
      const keep: boolean[] = [];
      for (const item of include.rows.flat()) {
        const truth = toBoolean(item);
        if (truth instanceof XError) return truth;
        keep.push(truth);
      }
      const source = byRow ? grid : transpose(grid);
      const rows = source.rows.filter((_, at) => keep[at]);
      if (!rows.length) return call.omitted(2) || args[2] === undefined ? CALC : args[2]!;
      const result = emptyAsZero(new Grid(rows));
      return byRow ? result : transpose(result);
    },
  },
  UNIQUE: {
    kinds: "rss",
    run: (args, call) => {
      const grid = gridOf(args[0] ?? null);
      if (grid instanceof XError) return grid;
      const byColumn = optionalBoolean(args, call, 1, false);
      const once = optionalBoolean(args, call, 2, false);
      if (byColumn instanceof XError) return byColumn;
      if (once instanceof XError) return once;
      const source = emptyAsZero(byColumn ? transpose(grid) : grid);
      const counts = new Map<string, number>();
      for (const row of source.rows) counts.set(rowKey(row), (counts.get(rowKey(row)) ?? 0) + 1);
      const seen = new Set<string>();
      const rows = source.rows.filter((row) => {
        const key = rowKey(row);
        if (seen.has(key) || (once && counts.get(key) !== 1)) return false;
        seen.add(key);
        return true;
      });
      if (!rows.length) return CALC;
      const result = new Grid(rows);
      return byColumn ? transpose(result) : result;
    },
  },
  SEQUENCE: {
    run: (args, call) => {
      const rows = number(args[0]);
      const columns = optionalNumber(args, call, 1, 1);
      const start = optionalNumber(args, call, 2, 1);
      const step = optionalNumber(args, call, 3, 1);
      for (const value of [rows, columns, start, step]) if (value instanceof XError) return value;
      const [h, w] = [Math.trunc(rows as number), Math.trunc(columns as number)];
      if (h < 1 || w < 1) return CALC;
      if (h * w > 1_048_576) return NUM;
      return new Grid(
        Array.from({ length: h }, (_, r) =>
          Array.from(
            { length: w },
            (_column, c) => (start as number) + (r * w + c) * (step as number),
          ),
        ),
      );
    },
  },
  // A legacy formula meets these ranges at its row, as Excel does.
  TAKE: { kinds: "vss", run: (args, call) => takeOrDrop(args, call, true) },
  DROP: { kinds: "vss", run: (args, call) => takeOrDrop(args, call, false) },
  CHOOSEROWS: {
    kinds: "r",
    run: (args) => {
      const grid = gridOf(args[0] ?? null);
      return grid instanceof XError ? grid : pickLines(grid, args.slice(1), false);
    },
  },
  CHOOSECOLS: {
    kinds: "r",
    run: (args) => {
      const grid = gridOf(args[0] ?? null);
      return grid instanceof XError ? grid : pickLines(grid, args.slice(1), true);
    },
  },
  VSTACK: { kinds: "|r", run: (args) => stack(args, false) },
  HSTACK: { kinds: "|r", run: (args) => stack(args, true) },
  TOCOL: { kinds: "rss", run: (args, call) => toLine(args, call, true) },
  TOROW: { kinds: "rss", run: (args, call) => toLine(args, call, false) },

  PROPER: {
    run: (args) => {
      const value = text(args[0]);
      return value instanceof XError
        ? value
        : value
            .toLowerCase()
            .replace(
              /(^|\P{L})(\p{L})/gu,
              (_, before: string, letter: string) => before + letter.toUpperCase(),
            );
    },
  },
  SEARCH: {
    run: (args, call) => {
      const needle = text(args[0]);
      const haystack = text(args[1]);
      if (needle instanceof XError) return needle;
      if (haystack instanceof XError) return haystack;
      const start = optionalNumber(args, call, 2, 1);
      if (start instanceof XError) return start;
      if (start < 1 || start > haystack.length + 1) return VALUE;
      if (!needle) return Math.trunc(start);
      const found = wildcard(needle).search(haystack.slice(Math.trunc(start) - 1));
      return found < 0 ? VALUE : found + Math.trunc(start);
    },
  },
  TEXT: {
    run: (args) => {
      const value = scalar(args[0]);
      const format = text(args[1]);
      if (value instanceof XError) return value;
      if (format instanceof XError) return format;
      const numeric = typeof value === "string" ? parseNumberText(value) : null;
      const shown =
        typeof value === "number"
          ? value
          : typeof value === "boolean"
            ? null
            : value === null
              ? 0
              : numeric;
      if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
      return formatted(shown ?? (value as string), format) ?? VALUE;
    },
  },
  VALUE: {
    run: (args) => {
      const value = scalar(args[0]);
      if (value instanceof XError) return value;
      if (typeof value === "number") return value;
      if (value === null) return 0;
      if (typeof value === "boolean") return VALUE;
      return parseNumberText(value) ?? VALUE;
    },
  },
  FIXED: {
    run: (args, call) => {
      const value = number(args[0]);
      const digits = optionalNumber(args, call, 1, 2);
      const plain = optionalBoolean(args, call, 2, false);
      if (value instanceof XError) return value;
      if (digits instanceof XError) return digits;
      if (plain instanceof XError) return plain;
      return fixed(value, digits, !plain);
    },
  },
  DOLLAR: {
    run: (args, call) => {
      const value = number(args[0]);
      const digits = optionalNumber(args, call, 1, 2);
      if (value instanceof XError) return value;
      if (digits instanceof XError) return digits;
      const shown = `$${fixed(Math.abs(value), digits, true)}`;
      return roundTo(value, digits) < 0 ? `(${shown})` : shown;
    },
  },
  // The cell shows the friendly name, or else the address.
  HYPERLINK: {
    run: (args, call) => {
      const address = text(args[0]);
      if (address instanceof XError) return address;
      return args.length < 2 || call.omitted(1) ? address : scalar(args[1]);
    },
  },
  CONCAT: {
    kinds: "|r",
    run: (args) => {
      let joined = "";
      for (const item of args.flatMap(flat)) {
        const piece = toText(item);
        if (piece instanceof XError) return piece;
        joined += piece;
      }
      return joined.length > 32_767 ? VALUE : joined;
    },
  },
  CONCATENATE: {
    run: (args) => {
      let joined = "";
      for (const item of args) {
        const piece = text(item);
        if (piece instanceof XError) return piece;
        joined += piece;
      }
      return joined.length > 32_767 ? VALUE : joined;
    },
  },
  TEXTJOIN: {
    kinds: "vs|r",
    run: (args) => {
      const delimiters = flat(args[0] ?? null).map(toText);
      const bad = delimiters.find((item) => item instanceof XError);
      if (bad) return bad;
      const skip = toBoolean(scalar(args[1]));
      if (skip instanceof XError) return skip;
      const pieces: string[] = [];
      for (const item of args.slice(2).flatMap(flat)) {
        const piece = toText(item);
        if (piece instanceof XError) return piece;
        if (skip && piece === "") continue;
        pieces.push(piece);
      }
      const joined = pieces.reduce(
        (all, piece, at) =>
          at ? all + (delimiters[(at - 1) % delimiters.length] as string) + piece : piece,
        "",
      );
      return joined.length > 32_767 ? VALUE : joined;
    },
  },
  TEXTBEFORE: { run: (args, call) => textAround(args, call, false) },
  TEXTAFTER: { run: (args, call) => textAround(args, call, true) },
  T: {
    kinds: "v",
    run: (args) => {
      const value = scalar(args[0] ?? null);
      return value instanceof XError ? value : typeof value === "string" ? value : "";
    },
  },
  N: {
    kinds: "v",
    run: (args) => {
      const value = scalar(args[0] ?? null);
      return value instanceof XError
        ? value
        : typeof value === "number"
          ? value
          : value === true
            ? 1
            : 0;
    },
  },

  DATE: {
    run: (args) => {
      const [y, m, d] = [number(args[0]), number(args[1]), number(args[2])];
      for (const value of [y, m, d]) if (value instanceof XError) return value;
      return serialOf(y as number, m as number, d as number) ?? NUM;
    },
  },
  YEAR: ofDate((parts) => parts.year),
  MONTH: ofDate((parts) => parts.month),
  DAY: ofDate((parts) => parts.day),
  WEEKDAY: {
    run: (args, call) => {
      const serial = number(args[0]);
      const type = optionalNumber(args, call, 1, 1);
      if (serial instanceof XError) return serial;
      if (type instanceof XError) return type;
      if (serial < 0) return NUM;
      const day = weekdayOf(serial);
      const kind = Math.trunc(type);
      if (kind === 1 || kind === 17) return day + 1;
      if (kind === 2 || kind === 11) return ((day + 6) % 7) + 1;
      if (kind === 3) return (day + 6) % 7;
      if (kind >= 12 && kind <= 16) return ((day - (kind - 10) + 7) % 7) + 1;
      return NUM;
    },
  },
  WEEKNUM: {
    run: (args, call) => {
      const serial = number(args[0]);
      const type = optionalNumber(args, call, 1, 1);
      if (serial instanceof XError) return serial;
      if (type instanceof XError) return type;
      const parts = partsOf(serial);
      if (!parts) return NUM;
      const kind = Math.trunc(type);
      if (kind === 21) return fromLibrary(library.ISOWEEKNUM(serial));
      const starts: Record<number, number> = {
        1: 0,
        2: 1,
        11: 1,
        12: 2,
        13: 3,
        14: 4,
        15: 5,
        16: 6,
        17: 0,
      };
      const start = starts[kind];
      if (start === undefined) return NUM;
      const newYear = serialOf(parts.year, 1, 1)!;
      const offset = (weekdayOf(newYear) - start + 7) % 7;
      return Math.floor((Math.floor(serial) - newYear + offset) / 7) + 1;
    },
  },
  DATEVALUE: {
    run: (args) => {
      const value = scalar(args[0]);
      if (value instanceof XError) return value;
      if (typeof value !== "string") return VALUE;
      const serial = parseDateText(value);
      return serial === null ? VALUE : Math.floor(serial);
    },
  },
  TIMEVALUE: {
    run: (args) => {
      const value = scalar(args[0]);
      if (value instanceof XError) return value;
      if (typeof value !== "string") return VALUE;
      const serial = parseDateText(value);
      return serial === null ? VALUE : serial - Math.floor(serial);
    },
  },
  TIME: {
    run: (args) => {
      const [h, m, s] = [number(args[0]), number(args[1]), number(args[2])];
      for (const value of [h, m, s]) if (value instanceof XError) return value;
      const seconds =
        Math.trunc(h as number) * 3600 + Math.trunc(m as number) * 60 + Math.trunc(s as number);
      if (seconds < 0) return NUM;
      return (seconds % 86_400) / 86_400;
    },
  },
  HOUR: ofClock((clock) => clock.hour),
  MINUTE: ofClock((clock) => clock.minute),
  SECOND: ofClock((clock) => clock.second),
  NETWORKDAYS: workdays("NETWORKDAYS", false),
  "NETWORKDAYS.INTL": workdays("NETWORKDAYS", true),
  WORKDAY: workdays("WORKDAY", false),
  "WORKDAY.INTL": workdays("WORKDAY", true),

  ISERROR: is((value) => value instanceof XError),
  ISERR: is((value) => value instanceof XError && value.code !== "#N/A"),
  ISNA: is((value) => value instanceof XError && value.code === "#N/A"),
  ISNUMBER: is((value) => typeof value === "number"),
  ISTEXT: is((value) => typeof value === "string"),
  ISNONTEXT: is((value) => typeof value !== "string"),
  ISLOGICAL: is((value) => typeof value === "boolean"),
  ISBLANK: is((value) => value === null),
  ISREF: {
    kinds: "r",
    errors: true,
    run: (args) => args[0] instanceof Areas || (args[0] instanceof Grid && args[0].ref !== null),
  },
  ISFORMULA: {
    kinds: "r",
    run: (args, call) => {
      const ref = args[0] instanceof Grid ? args[0].ref : null;
      return ref ? call.isFormula(ref.sheet, ref.box.top, ref.box.left) : VALUE;
    },
  },
  TYPE: {
    kinds: "v",
    errors: true,
    run: (args) => {
      const value = args[0] ?? null;
      if (value instanceof Grid || value instanceof Areas)
        return value instanceof Grid && value.height === 1 && value.width === 1
          ? typeOf(value.rows[0]![0]!)
          : 64;
      return typeOf(value);
    },
  },
  "ERROR.TYPE": {
    errors: true,
    run: (args) => {
      const value = scalar(args[0]);
      return value instanceof XError ? (ERROR_TYPES[value.code] ?? NA) : NA;
    },
  },
};

function typeOf(value: Scalar) {
  if (value instanceof XError) return 16;
  if (typeof value === "string") return 2;
  if (typeof value === "boolean") return 4;
  return 1;
}

function rank(args: Value[], call: Call, averaged: boolean): Value {
  const value = number(args[0]);
  if (value instanceof XError) return value;
  const values = numbersOf([args[1] ?? null], call);
  if (values instanceof XError) return values;
  const order = optionalNumber(args, call, 2, 0);
  if (order instanceof XError) return order;
  const ties = values.filter((item) => round15(item) === round15(value)).length;
  if (!ties) return NA;
  const ahead = values.filter(
    (item) => (order ? item < value : item > value) && round15(item) !== round15(value),
  ).length;
  return averaged ? ahead + (ties + 1) / 2 : ahead + 1;
}

function toLine(args: Value[], call: Call, column: boolean): Value {
  const grid = gridOf(args[0] ?? null);
  if (grid instanceof XError) return grid;
  const ignore = optionalNumber(args, call, 1, 0);
  const byColumn = optionalBoolean(args, call, 2, false);
  if (ignore instanceof XError) return ignore;
  if (byColumn instanceof XError) return byColumn;
  const items = (byColumn ? transpose(grid) : grid).rows
    .flat()
    .filter(
      (item) =>
        !((ignore === 1 || ignore === 3) && item === null) &&
        !((ignore === 2 || ignore === 3) && item instanceof XError),
    )
    .map((item) => (item === null ? 0 : item));
  if (!items.length) return CALC;
  return column ? new Grid(items.map((item) => [item])) : new Grid([items]);
}

/** The first error among the arguments a function would read, so formula.js never sees one. */
export const errorIn = (args: readonly Value[]) => firstError(args.flatMap(flat));

/** Every function a formula may call, by name, sorted: the engine's own and the library's. */
export function functionNames(): readonly string[] {
  const names = new Set(Object.keys(FUNCTIONS));
  const walk = (node: unknown, prefix: string) => {
    if (!node || (typeof node !== "object" && typeof node !== "function")) return;
    for (const [key, child] of Object.entries(node)) {
      if (!/^[A-Z][A-Z0-9]*$/.test(key)) continue;
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof child === "function") names.add(name);
      walk(child, name);
    }
  };
  walk(libraryTable, "");
  // Evaluated as special forms rather than from this table.
  for (const name of ["LET", "GROUPBY", "PIVOTBY"]) names.add(name);
  return [...names].toSorted();
}
