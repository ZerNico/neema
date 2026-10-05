import { columnLetters, type CellBox } from "../../operations.ts";
import {
  errorIn,
  FUNCTIONS,
  fromLibrary,
  kindAt,
  LIBRARY_KINDS,
  LIBRARY_NUMBERS,
  libraryFunction,
  toLibrary,
  type Call,
  type Fn,
} from "./functions.ts";
import { Unsupported, type Node } from "./parse.ts";
import {
  Areas,
  compare,
  DIV0,
  Grid,
  NA,
  NAME,
  NULL,
  NUM,
  REF,
  toBoolean,
  toNumber,
  toText,
  VALUE,
  XError,
  type Ref,
  type Scalar,
  type Value,
} from "./values.ts";

export { Grid, XError, type Scalar, type Value } from "./values.ts";

/** What evaluation needs from the workbook around a formula. */
export interface Scope {
  /** The sheet the formula is on. */
  readonly sheet: string;
  readonly row: number;
  readonly column: number;
  /** One cell's current value; a sheet that doesn't exist is #REF!. */
  cell(sheet: string, row: number, column: number): Scalar;
  /** A box clipped to where the sheet has content, so a whole column is not a million reads. */
  clip(sheet: string, box: CellBox): CellBox | null;
  /** A defined name's formula, for the formula's sheet. */
  name(name: string): Node | null;
  /** The sheets from `first` to `last` in workbook order, or null if either is missing. */
  sheets(first: string, last: string): string[] | null;
  isFormula(sheet: string, row: number, column: number): boolean;
  /** The cells an array formula at this cell currently fills, or null. */
  spill(sheet: string, row: number, column: number): CellBox | null;
  /** Text read as a formula in this workbook (INDIRECT), or null. */
  parse(text: string): Node | null;
}

/**
 * How a formula treats a range where one value belongs:
 * - `legacy`: a formula saved without dynamic arrays; the range meets the
 *   formula's row or column (implicit intersection), as Excel does for it
 * - `dynamic`: Excel 365; the range is used element by element and may spill
 * - `array`: inside an array formula or an argument that takes arrays
 */
export type Mode = "legacy" | "dynamic" | "array";

/** Past this many cells, a range is read only where the sheet has content. */
const DENSE_CELLS = 10_000;
const MAX_DEPTH = 200;

/** The value where one cell fits, and whether that took a range apart. */
class Evaluation {
  readonly scope: Scope;
  /** A range met a single-value place in a dynamic formula: legacy Excel would read it differently. */
  lifted = false;
  private depth = 0;
  private readonly locals: Array<Map<string, Value>> = [];

  constructor(scope: Scope) {
    this.scope = scope;
  }

  cells(ref: Ref): Grid {
    const { sheet, box } = ref;
    const area = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    const read = area > DENSE_CELLS ? this.scope.clip(sheet, box) : box;
    if (!read) return new Grid([[null]], ref);
    const rows: Scalar[][] = [];
    for (let row = read.top; row <= read.bottom; row++) {
      const line: Scalar[] = [];
      for (let column = read.left; column <= read.right; column++)
        line.push(this.scope.cell(sheet, row, column));
      rows.push(line);
    }
    return new Grid(rows, ref);
  }

  /** The one cell of `ref` in the formula's row or column, as legacy Excel reads a range. */
  intersect(ref: Ref): Scalar {
    const { box } = ref;
    const row = box.top === box.bottom ? box.top : this.scope.row;
    const column = box.left === box.right ? box.left : this.scope.column;
    if (row < box.top || row > box.bottom || column < box.left || column > box.right) return VALUE;
    return this.scope.cell(ref.sheet, row, column);
  }

  /** A value where one belongs: one cell, an intersection, or an array to lift over. */
  single(value: Value, mode: Mode): Scalar | Grid {
    if (value instanceof Areas) return VALUE;
    if (!(value instanceof Grid)) return value;
    if (value.height === 1 && value.width === 1) return value.rows[0]![0]!;
    if (value.ref) {
      if (mode === "legacy") return this.intersect(value.ref);
      if (mode === "dynamic") this.lifted = true;
    }
    return value;
  }

  evaluate(node: Node, mode: Mode): Value {
    if (++this.depth > MAX_DEPTH) throw new Unsupported("a formula nested too deeply");
    try {
      return this.node(node, mode);
    } finally {
      this.depth -= 1;
    }
  }

  private reference(value: Value): Ref | null {
    return value instanceof Grid ? value.ref : null;
  }

  private node(node: Node, mode: Mode): Value {
    switch (node.t) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "err":
        return new XError(node.v);
      case "missing":
        return null;
      case "ref":
        return this.cells({ sheet: node.sheet ?? this.scope.sheet, box: node.box });
      case "ref3d": {
        const sheets = this.scope.sheets(node.first, node.last);
        if (!sheets) return REF;
        return new Areas(sheets.map((sheet) => this.cells({ sheet, box: node.box })));
      }
      case "name": {
        const key = node.name.toLowerCase();
        for (let at = this.locals.length - 1; at >= 0; at--) {
          const local = this.locals[at]!;
          if (local.has(key)) return local.get(key)!;
        }
        const target = this.scope.name(node.name);
        return target ? this.evaluate(target, mode) : NAME;
      }
      case "arr":
        return new Grid(
          node.rows.map((row) =>
            row.map((item) => {
              const value = this.evaluate(item, "array");
              return value instanceof Grid
                ? (value.rows[0]?.[0] ?? null)
                : value instanceof Areas
                  ? VALUE
                  : value;
            }),
          ),
        );
      case "neg":
        return map(this.single(this.evaluate(node.x, mode), mode), (x) => arithmetic("-", 0, x));
      case "pct":
        return map(this.single(this.evaluate(node.x, mode), mode), (x) => arithmetic("/", x, 100));
      case "bin": {
        const a = this.single(this.evaluate(node.a, mode), mode);
        const b = this.single(this.evaluate(node.b, mode), mode);
        return lift([a, b], ([x, y]) => operate(node.op, x!, y!));
      }
      case "range":
      case "isect": {
        const a = this.reference(this.evaluate(node.a, mode));
        const b = this.reference(this.evaluate(node.b, mode));
        if (!a || !b || a.sheet.toLowerCase() !== b.sheet.toLowerCase()) return VALUE;
        const box =
          node.t === "range"
            ? {
                top: Math.min(a.box.top, b.box.top),
                left: Math.min(a.box.left, b.box.left),
                bottom: Math.max(a.box.bottom, b.box.bottom),
                right: Math.max(a.box.right, b.box.right),
              }
            : {
                top: Math.max(a.box.top, b.box.top),
                left: Math.max(a.box.left, b.box.left),
                bottom: Math.min(a.box.bottom, b.box.bottom),
                right: Math.min(a.box.right, b.box.right),
              };
        if (box.top > box.bottom || box.left > box.right) return NULL;
        return this.cells({ sheet: a.sheet, box });
      }
      case "union": {
        const grids: Grid[] = [];
        for (const item of node.items) {
          const value = this.evaluate(item, mode);
          if (value instanceof Areas) grids.push(...value.grids);
          else if (value instanceof Grid && value.ref) grids.push(value);
          else return VALUE;
        }
        return new Areas(grids);
      }
      case "call":
        return this.call(node.name, node.args, mode);
    }
  }

  private branch(args: readonly Node[], index: number, mode: Mode, fallback: Value): Value {
    const arg = args[index];
    return arg && arg.t !== "missing" ? this.evaluate(arg, mode) : arg ? 0 : fallback;
  }

  /** Branching functions evaluate only the branch they take, so the other can't raise an error. */
  private special(name: string, args: readonly Node[], mode: Mode): Value | undefined {
    switch (name) {
      case "IF": {
        const test = this.single(this.evaluate(args[0] ?? { t: "missing" }, mode), mode);
        if (test instanceof Grid) {
          // An array condition picks per element; both branches are needed.
          const yes = this.single(this.branch(args, 1, mode, true), mode);
          const no = this.single(this.branch(args, 2, mode, false), mode);
          return lift([test, yes, no], ([condition, a, b]) => {
            const truth = toBoolean(condition!);
            return truth instanceof XError ? truth : truth ? a! : b!;
          });
        }
        const truth = toBoolean(test);
        if (truth instanceof XError) return truth;
        return this.branch(args, truth ? 1 : 2, mode, truth);
      }
      case "IFERROR":
      case "IFNA": {
        const value = this.evaluate(args[0] ?? { t: "missing" }, mode);
        const failed = (item: Scalar) =>
          item instanceof XError && (name === "IFERROR" || item.code === "#N/A");
        const checked = this.single(value, mode);
        if (checked instanceof Grid) {
          if (!checked.rows.flat().some(failed)) return checked;
          const fallback = this.single(this.branch(args, 1, mode, ""), mode);
          return lift([checked, fallback], ([item, other]) => (failed(item!) ? other! : item!));
        }
        return failed(checked) ? this.branch(args, 1, mode, "") : value;
      }
      case "IFS": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          const test = this.single(this.evaluate(args[index]!, mode), mode);
          const truth = toBoolean(test instanceof Grid ? (test.rows[0]?.[0] ?? null) : test);
          if (truth instanceof XError) return truth;
          if (truth) return this.evaluate(args[index + 1]!, mode);
        }
        return NA;
      }
      case "SWITCH": {
        const subject = this.single(this.evaluate(args[0] ?? { t: "missing" }, mode), mode);
        const key = subject instanceof Grid ? (subject.rows[0]?.[0] ?? null) : subject;
        if (key instanceof XError) return key;
        let index = 1;
        for (; index + 1 < args.length; index += 2) {
          const option = this.single(this.evaluate(args[index]!, mode), mode);
          const value = option instanceof Grid ? (option.rows[0]?.[0] ?? null) : option;
          if (value instanceof XError) return value;
          if (typeof value === typeof key && compare(value, key) === 0)
            return this.evaluate(args[index + 1]!, mode);
        }
        return index < args.length ? this.evaluate(args[index]!, mode) : NA;
      }
      case "CHOOSE": {
        const pick = this.single(this.evaluate(args[0] ?? { t: "missing" }, mode), mode);
        if (pick instanceof Grid)
          return lift([pick], ([at]) => {
            const index = toNumber(at!);
            if (index instanceof XError) return index;
            const choice = args[Math.trunc(index)];
            if (index < 1 || !choice) return VALUE;
            const value = this.single(this.evaluate(choice, mode), mode);
            return value instanceof Grid ? (value.rows[0]?.[0] ?? null) : value;
          });
        const index = toNumber(pick);
        if (index instanceof XError) return index;
        const choice = args[Math.trunc(index)];
        return index >= 1 && choice ? this.branch(args, Math.trunc(index), mode, 0) : VALUE;
      }
      case "LET": {
        if (args.length < 3 || args.length % 2 === 0) return VALUE;
        const frame = new Map<string, Value>();
        this.locals.push(frame);
        try {
          for (let index = 0; index + 1 < args.length; index += 2) {
            const binding = args[index]!;
            if (binding.t !== "name") return VALUE;
            frame.set(binding.name.toLowerCase(), this.evaluate(args[index + 1]!, mode));
          }
          return this.evaluate(args.at(-1)!, mode);
        } finally {
          this.locals.pop();
        }
      }
      case "RAND":
      case "RANDBETWEEN":
      case "RANDARRAY":
      case "NOW":
      case "TODAY":
      case "CELL":
      case "INFO":
      case "LAMBDA":
        // Their result changes with time, chance or the machine; Excel computes them on open.
        throw new Unsupported(name);
      default:
        return undefined;
    }
  }

  private call(name: string, nodes: readonly Node[], mode: Mode): Value {
    const special = this.special(name, nodes, mode);
    if (special !== undefined) return special;
    const own = FUNCTIONS[name];
    const implementation = libraryFunction(name);
    if (!own && !implementation) throw new Unsupported(name);
    const kinds = own ? (own.kinds ?? "") : (LIBRARY_KINDS[name] ?? "");
    const args: Value[] = nodes.map((node, index) => {
      const kind = kindAt(kinds, index);
      if (kind === "a") return this.evaluate(node, "array");
      const value = this.evaluate(node, mode);
      if (kind === "r") return value;
      if (kind === "v") {
        if (mode === "legacy") return this.single(value, mode);
        // Legacy Excel would have met this range at the formula's row, so the formula must be saved dynamic.
        if (
          mode === "dynamic" &&
          value instanceof Grid &&
          value.ref &&
          (value.height > 1 || value.width > 1)
        )
          this.lifted = true;
        return value;
      }
      return this.single(value, mode);
    });
    const call: Call = {
      sheet: this.scope.sheet,
      row: this.scope.row,
      column: this.scope.column,
      omitted: (index) => nodes[index] === undefined || nodes[index]!.t === "missing",
      cells: (ref) => this.cells(ref),
      reference: (text, a1) => this.indirect(text, a1),
      isFormula: (sheet, row, column) => this.scope.isFormula(sheet, row, column),
      spill: (sheet, row, column) => this.scope.spill(sheet, row, column),
    };
    const fn: Fn = own ?? {
      run: (values) => runLibrary(name, implementation!, values, nodes, call),
    };
    // A single-value argument given an array runs the function once per element.
    const lifted = args.flatMap((value, index) =>
      kindAt(kinds, index) === "s" && value instanceof Grid ? [index] : [],
    );
    const runOnce = (values: Value[]): Value => {
      if (!fn.errors)
        for (const [index, value] of values.entries())
          if (value instanceof XError && kindAt(kinds, index) === "s") return value;
      return fn.run(values, call);
    };
    if (!lifted.length) return runOnce(args);
    return lift(
      lifted.map((index) => args[index] as Grid),
      (items) => {
        const values = [...args];
        lifted.forEach((index, at) => (values[index] = items[at]!));
        const result = runOnce(values);
        return result instanceof Grid
          ? (result.rows[0]?.[0] ?? null)
          : result instanceof Areas
            ? VALUE
            : result;
      },
    );
  }

  /** INDIRECT's text as a reference: A1 style, or R1C1 when asked. */
  private indirect(text: string, a1: boolean): Grid | Areas | null {
    let source = text.trim().replace(/^=/, "");
    if (!a1) {
      const converted = fromR1C1(source);
      if (!converted) return null;
      source = converted;
    }
    const node = this.scope.parse(source);
    if (!node || !["ref", "ref3d", "name", "range"].includes(node.t)) return null;
    const value = this.evaluate(node, "array");
    return value instanceof Areas || (value instanceof Grid && value.ref) ? value : null;
  }
}

const corner = (row: string, column: string) => `${columnLetters(Number(column))}${row}`;

/** "R2C3" or "Sheet!R1C1:R2C2" (absolute only) as A1 text. */
function fromR1C1(text: string): string | null {
  const match = /^(?:(.+)!)?R(\d+)C(\d+)(?::R(\d+)C(\d+))?$/i.exec(text);
  if (!match) return null;
  const area = match[4]
    ? `${corner(match[2]!, match[3]!)}:${corner(match[4], match[5]!)}`
    : corner(match[2]!, match[3]!);
  return match[1] ? `${match[1]}!${area}` : area;
}

function runLibrary(
  name: string,
  implementation: (...args: unknown[]) => unknown,
  values: Value[],
  nodes: readonly Node[],
  call: Call,
): Value {
  const error = errorIn(values);
  if (error) return error;
  // Trailing omitted arguments take the function's defaults.
  let count = values.length;
  while (count > 0 && call.omitted(count - 1)) count -= 1;
  const prepared = values.slice(0, count).map((value, index) => {
    if (LIBRARY_NUMBERS.has(name) && (value instanceof Grid || value instanceof Areas))
      return (value instanceof Areas ? value.grids : [value]).flatMap((grid) =>
        grid.rows.flat().filter((item) => typeof item === "number"),
      );
    return nodes[index]?.t === "missing" ? null : toLibrary(value);
  });
  try {
    return fromLibrary(implementation(...prepared));
  } catch {
    return VALUE;
  }
}

/** Applies `apply` element by element; a single row or column spreads across the others. */
function lift(
  values: ReadonlyArray<Scalar | Grid>,
  apply: (items: Scalar[]) => Scalar,
): Scalar | Grid {
  if (!values.some((value) => value instanceof Grid)) return apply(values as Scalar[]);
  const shapes = values.map((value) =>
    value instanceof Grid ? { h: value.height, w: value.width } : { h: 1, w: 1 },
  );
  const height = Math.max(...shapes.map((shape) => shape.h));
  const width = Math.max(...shapes.map((shape) => shape.w));
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- a module-level at would shadow the at used elsewhere in this file
  const at = (value: Scalar | Grid, row: number, column: number): Scalar => {
    if (!(value instanceof Grid)) return value;
    const r = value.height === 1 ? 0 : row;
    const c = value.width === 1 ? 0 : column;
    return r < value.height && c < value.width ? value.rows[r]![c]! : NA;
  };
  return new Grid(
    Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_cell, column) =>
        apply(values.map((value) => at(value, row, column))),
      ),
    ),
  );
}
const map = (value: Scalar | Grid, apply: (x: Scalar) => Scalar) =>
  lift([value], ([x]) => apply(x!));

function arithmetic(op: string, a: Scalar, b: Scalar): Scalar {
  const x = toNumber(a);
  const y = toNumber(b);
  if (x instanceof XError) return x;
  if (y instanceof XError) return y;
  const result =
    op === "+"
      ? x + y
      : op === "-"
        ? x - y
        : op === "*"
          ? x * y
          : op === "/"
            ? y === 0
              ? DIV0
              : x / y
            : x === 0 && y < 0
              ? DIV0
              : x ** y;
  return typeof result === "number" && !Number.isFinite(result) ? NUM : result;
}

function operate(op: string, a: Scalar, b: Scalar): Scalar {
  if (a instanceof XError) return a;
  if (b instanceof XError) return b;
  if (op === "&") {
    const joined = (toText(a) as string) + (toText(b) as string);
    return joined.length > 32_767 ? VALUE : joined;
  }
  if (["=", "<>", "<", ">", "<=", ">="].includes(op)) {
    const order = compare(a, b);
    return op === "="
      ? order === 0
      : op === "<>"
        ? order !== 0
        : op === "<"
          ? order < 0
          : op === ">"
            ? order > 0
            : op === "<="
              ? order <= 0
              : order >= 0;
  }
  return arithmetic(op, a, b);
}

/** A formula's value in `mode`, and whether a dynamic formula relied on arrays to get it. */
export function evaluateFormula(node: Node, scope: Scope, mode: Mode) {
  const evaluation = new Evaluation(scope);
  const raw = evaluation.evaluate(node, mode);
  const value: Scalar | Grid =
    raw instanceof Areas
      ? VALUE
      : raw instanceof Grid && raw.ref && mode === "legacy"
        ? evaluation.single(raw, mode)
        : raw;
  return { value, lifted: evaluation.lifted };
}
