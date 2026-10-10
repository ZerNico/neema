import { columnIndex, MAX_COLUMN, MAX_ROW, type CellBox } from "@chat/sheet/a1";

/**
 * A formula this engine does not evaluate: a construct it doesn't parse or a
 * function it doesn't have. Such a cell keeps the value the file carried.
 */
export class Unsupported extends Error {
  readonly what: string;
  constructor(what: string) {
    super(what);
    this.name = "Unsupported";
    this.what = what;
  }
}

export type RefNode = {
  readonly t: "ref";
  readonly sheet: string | null;
  readonly box: CellBox;
  readonly single: boolean;
};
export type Node =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "bool"; readonly v: boolean }
  | { readonly t: "err"; readonly v: string }
  | { readonly t: "missing" }
  | RefNode
  /** `First:Last!A1`: the same cells on every sheet from First to Last. */
  | { readonly t: "ref3d"; readonly first: string; readonly last: string; readonly box: CellBox }
  | { readonly t: "name"; readonly name: string }
  | { readonly t: "call"; readonly name: string; readonly args: readonly Node[] }
  | { readonly t: "neg" | "pct"; readonly x: Node }
  | { readonly t: "bin"; readonly op: string; readonly a: Node; readonly b: Node }
  /** `:` between references, a space (their intersection) and a parenthesized union. */
  | { readonly t: "range" | "isect"; readonly a: Node; readonly b: Node }
  | { readonly t: "union"; readonly items: readonly Node[] }
  | { readonly t: "arr"; readonly rows: readonly (readonly Node[])[] };

/** An Excel table as structured references see it. */
export interface TableShape {
  readonly sheet: string;
  readonly box: CellBox;
  readonly headerRows: number;
  readonly totalsRows: number;
  readonly columns: readonly string[];
}
export interface ParseContext {
  /** A table by name, or the table around the formula's cell for `[@Column]`. */
  readonly table?: (name: string | null) => TableShape | null;
  /** The formula's row, for `[@Column]`. */
  readonly row?: number;
}

type Token =
  | { readonly k: "num"; readonly v: number }
  | { readonly k: "str" | "err" | "op"; readonly v: string }
  | { readonly k: "ref"; readonly node: Node }
  | { readonly k: "id"; readonly v: string; readonly call: boolean };

const ERRORS = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#SPILL!",
  "#CALC!",
  "#GETTING_DATA",
];
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const COLUMNS = String.raw`\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}`;
const ROWS = String.raw`\$?\d{1,7}:\$?\d{1,7}`;
const AREA = `(?:${CELL}(?::${CELL})?|${COLUMNS}|${ROWS})`;
const SHEET = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_À-￿][\w.À-￿]*)`;
const BARE_SHEET = String.raw`[A-Za-z_À-￿][\w.À-￿]*`;
const patterns = {
  space: /\s+/y,
  string: /"(?:[^"]|"")*"/y,
  number: /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y,
  sheets: new RegExp(`(${BARE_SHEET}):(${BARE_SHEET})!(${AREA})(?![\\w(])`, "y"),
  qualified: new RegExp(`(${SHEET})!(${AREA})(?![\\w(])`, "y"),
  area: new RegExp(`(${AREA})(?![\\w(!\\[])`, "y"),
  id: /[A-Za-z_\\À-￿][\w.À-￿]*/y,
  op: /<>|<=|>=|[-+*/^&=<>%(),;{}:]/y,
};

const at = (pattern: RegExp, text: string, index: number) => {
  pattern.lastIndex = index;
  return pattern.exec(text);
};

/** "B7" to its row and column. */
const corner = (text: string) => {
  const match = /^([A-Z]+)(\d+)$/.exec(text)!;
  return { row: Number(match[2]), column: columnIndex(match[1]!) };
};

/** "A1:B3", "C:C" or "2:4" to a box; whole columns and rows span the grid. */
function box(area: string): { box: CellBox; single: boolean } {
  const plain = area.replaceAll("$", "").toUpperCase();
  const [from, to = from] = plain.split(":") as [string, string?];
  if (/^[A-Z]+$/.test(from)) {
    const [a, b] = [columnIndex(from), columnIndex(to!)];
    if (a > MAX_COLUMN || b > MAX_COLUMN) throw new Unsupported("a reference past the grid");
    return {
      box: { top: 1, bottom: MAX_ROW, left: Math.min(a, b), right: Math.max(a, b) },
      single: false,
    };
  }
  if (/^\d+$/.test(from)) {
    const [a, b] = [Number(from), Number(to)];
    if (!a || !b || a > MAX_ROW || b > MAX_ROW) throw new Unsupported("a reference past the grid");
    return {
      box: { top: Math.min(a, b), bottom: Math.max(a, b), left: 1, right: MAX_COLUMN },
      single: false,
    };
  }
  const [a, b] = [corner(from), corner(to!)];
  if (
    a.column > MAX_COLUMN ||
    b.column > MAX_COLUMN ||
    a.row > MAX_ROW ||
    b.row > MAX_ROW ||
    !a.row ||
    !b.row
  )
    throw new Unsupported("a reference past the grid");
  return {
    box: {
      top: Math.min(a.row, b.row),
      bottom: Math.max(a.row, b.row),
      left: Math.min(a.column, b.column),
      right: Math.max(a.column, b.column),
    },
    single: a.row === b.row && a.column === b.column,
  };
}

const unquote = (sheet: string) =>
  sheet.startsWith("'") ? sheet.slice(1, -1).replaceAll("''", "'") : sheet;

/** The text of a bracketed structured reference from `start` (an opening "["), and where it ends. */
function bracketed(text: string, start: number) {
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const character = text[index];
    if (character === "'") {
      index += 1;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]" && --depth === 0)
      return { inner: text.slice(start + 1, index), end: index + 1 };
  }
  throw new Unsupported("an unclosed table reference");
}

const SPECIALS = new Set(["#all", "#data", "#headers", "#totals", "#this row"]);
const columnName = (raw: string) => raw.trim().replace(/'(.)/g, "$1").toLowerCase();

/** `Table[...]` to the cells it names, as Excel resolves structured references. */
function structured(tableName: string | null, inner: string, context: ParseContext): Node {
  const table = context.table?.(tableName) ?? null;
  if (!table)
    throw new Unsupported(
      tableName ? `the table "${tableName}"` : "a table reference outside a table",
    );
  // Items: specials like #Headers, and column names or column spans.
  const specials = new Set<string>();
  let columns: [number, number] | null = null;
  const column = (name: string) => {
    const index = table.columns.findIndex((each) => each.toLowerCase() === columnName(name));
    if (index < 0) throw new Unsupported(`the table column "${name.trim()}"`);
    return index;
  };
  const addColumns = (from: string, to: string) => {
    const [a, b] = [column(from), column(to)];
    columns = [Math.min(a, b), Math.max(a, b)];
  };
  let body = inner.trim();
  if (body.startsWith("@")) {
    specials.add("#this row");
    body = body.slice(1).trim();
  }
  if (body.startsWith("[")) {
    // [[#Headers],[A]:[B]] or @[A]
    const items: string[] = [];
    let index = 0;
    while (index < body.length) {
      if (body[index] === "[") {
        const part = bracketed(body, index);
        items.push(part.inner);
        index = part.end;
      } else if (body[index] === ":") {
        items.push(":");
        index += 1;
      } else index += 1;
    }
    for (let item = 0; item < items.length; item++) {
      const name = items[item]!;
      if (name === ":") continue;
      if (SPECIALS.has(name.trim().toLowerCase())) specials.add(name.trim().toLowerCase());
      else if (items[item + 1] === ":" && items[item + 2] !== undefined) {
        addColumns(name, items[item + 2]!);
        item += 2;
      } else addColumns(name, name);
    }
  } else if (body) {
    if (SPECIALS.has(body.toLowerCase())) specials.add(body.toLowerCase());
    else addColumns(body, body);
  }
  const { box: all, headerRows, totalsRows } = table;
  const dataTop = all.top + headerRows;
  const dataBottom = all.bottom - totalsRows;
  let top = dataTop;
  let bottom = dataBottom;
  if (specials.has("#all")) [top, bottom] = [all.top, all.bottom];
  else if (specials.has("#this row")) {
    const row = context.row;
    if (row === undefined || row < dataTop || row > dataBottom) return { t: "err", v: "#VALUE!" };
    [top, bottom] = [row, row];
  } else if (specials.size) {
    const rows: number[] = [];
    if (specials.has("#headers")) {
      if (!headerRows) return { t: "err", v: "#REF!" };
      rows.push(all.top, dataTop - 1);
    }
    if (specials.has("#data")) rows.push(dataTop, dataBottom);
    if (specials.has("#totals")) {
      if (!totalsRows) return { t: "err", v: "#REF!" };
      rows.push(dataBottom + 1, all.bottom);
    }
    [top, bottom] = [Math.min(...rows), Math.max(...rows)];
  }
  const span: [number, number] = columns ?? [0, table.columns.length - 1];
  const cells = {
    top,
    bottom,
    left: all.left + span[0],
    right: all.left + span[1],
  };
  return {
    t: "ref",
    sheet: table.sheet,
    box: cells,
    single: cells.top === cells.bottom && cells.left === cells.right,
  };
}

function tokenize(text: string, context: ParseContext): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    let match = at(patterns.space, text, index);
    if (match) {
      index += match[0].length;
      // A space between two references is Excel's intersection operator.
      const previous = tokens.at(-1);
      const joins =
        previous &&
        (previous.k === "ref" ||
          (previous.k === "op" && previous.v === ")") ||
          (previous.k === "id" && !previous.call));
      if (joins && /[A-Za-z_$'(\\À-￿]/.test(text[index] ?? "")) tokens.push({ k: "op", v: " " });
      continue;
    }
    if ((match = at(patterns.string, text, index))) {
      tokens.push({ k: "str", v: match[0].slice(1, -1).replaceAll('""', '"') });
      index += match[0].length;
      continue;
    }
    const error = ERRORS.find(
      (code) => text.slice(index, index + code.length).toUpperCase() === code,
    );
    if (error) {
      tokens.push({ k: "err", v: error });
      index += error.length;
      continue;
    }
    if ((match = at(patterns.sheets, text, index))) {
      tokens.push({
        k: "ref",
        node: { t: "ref3d", first: match[1]!, last: match[2]!, box: box(match[3]!).box },
      });
      index += match[0].length;
      continue;
    }
    if ((match = at(patterns.qualified, text, index))) {
      const sheet = unquote(match[1]!);
      const area = box(match[2]!);
      // Sheet names can't hold a colon, so 'First:Last'!A1 is a 3-D reference.
      const split = sheet.indexOf(":");
      tokens.push({
        k: "ref",
        node:
          split > 0
            ? {
                t: "ref3d",
                first: sheet.slice(0, split),
                last: sheet.slice(split + 1),
                box: area.box,
              }
            : { t: "ref", sheet, ...area },
      });
      index += match[0].length;
      continue;
    }
    if ((match = at(patterns.area, text, index))) {
      // "12:30" in a formula is a row range, as Excel reads it too.
      tokens.push({ k: "ref", node: { t: "ref", sheet: null, ...box(match[1]!) } });
      index += match[0].length;
      continue;
    }
    if ((match = at(patterns.number, text, index))) {
      tokens.push({ k: "num", v: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    if (text[index] === "[") {
      const part = bracketed(text, index);
      tokens.push({ k: "ref", node: structured(null, part.inner, context) });
      index = part.end;
      continue;
    }
    if ((match = at(patterns.id, text, index))) {
      index += match[0].length;
      if (text[index] === "[") {
        const part = bracketed(text, index);
        tokens.push({ k: "ref", node: structured(match[0], part.inner, context) });
        index = part.end;
        continue;
      }
      if (text[index] === "!") throw new Unsupported("an external or computed reference");
      const rest = text.slice(index).trimStart();
      tokens.push({ k: "id", v: match[0], call: rest.startsWith("(") });
      continue;
    }
    if ((match = at(patterns.op, text, index))) {
      tokens.push({ k: "op", v: match[0] });
      index += match[0].length;
      continue;
    }
    throw new Unsupported(`the character "${text[index]}"`);
  }
  return tokens;
}

const COMPARE = new Set(["=", "<>", "<", ">", "<=", ">="]);

/**
 * Parses a stored formula (no leading "="). Namespace prefixes are the file's,
 * not the function's; a table the context doesn't know is unsupported.
 */
export function parseFormula(text: string, context: ParseContext = {}): Node {
  const tokens = tokenize(text.replace(/^=/, ""), context);
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value: string) => {
    const token = peek();
    return token?.k === "op" && token.v === value;
  };
  const expect = (value: string) => {
    if (!isOp(value))
      throw new Unsupported(`a formula this engine can't read (expected "${value}")`);
    position += 1;
  };
  const binary = (next: () => Node, ops: (op: string) => boolean) => (): Node => {
    let left = next();
    for (let token = peek(); token?.k === "op" && ops(token.v); token = peek()) {
      position += 1;
      left = { t: "bin", op: token.v, a: left, b: next() };
    }
    return left;
  };
  const primary = (): Node => {
    const token = tokens[position++];
    if (!token) throw new Unsupported("an incomplete formula");
    switch (token.k) {
      case "num":
        return { t: "num", v: token.v };
      case "str":
        return { t: "str", v: token.v };
      case "err":
        return { t: "err", v: token.v };
      case "ref":
        return token.node;
      case "id": {
        const name = token.v.replace(/^_xlfn\.(?:_xlws\.)?/i, "").toUpperCase();
        if (!token.call) {
          if (name === "TRUE" || name === "FALSE") return { t: "bool", v: name === "TRUE" };
          return { t: "name", name: token.v.replace(/^_xlpm\./i, "") };
        }
        expect("(");
        const args: Node[] = [];
        if (!isOp(")"))
          for (;;) {
            // An omitted argument, as in IF(A1,,2), is missing, not empty text.
            args.push(isOp(",") || isOp(")") ? { t: "missing" } : comparison());
            if (!isOp(",")) break;
            position += 1;
          }
        expect(")");
        return { t: "call", name, args };
      }
      case "op":
        if (token.v === "(") {
          const inner = comparison();
          if (!isOp(",")) {
            expect(")");
            return inner;
          }
          // (A1:A3,C1:C3) is a union of references.
          const items = [inner];
          while (isOp(",")) {
            position += 1;
            items.push(comparison());
          }
          expect(")");
          return { t: "union", items };
        }
        if (token.v === "{") {
          const rows: Node[][] = [[]];
          for (;;) {
            rows.at(-1)!.push(unary());
            if (isOp(",")) position += 1;
            else if (isOp(";")) {
              position += 1;
              rows.push([]);
            } else break;
          }
          expect("}");
          if (rows.some((row) => row.length !== rows[0]!.length))
            throw new Unsupported("an array constant with uneven rows");
          return { t: "arr", rows };
        }
        throw new Unsupported(`the operator "${token.v}" here`);
    }
  };
  // Reference operators bind tightest: A1:B2 C1:C9 is one intersection.
  const reference = (): Node => {
    let node = primary();
    for (;;) {
      if (isOp(":")) {
        position += 1;
        node = { t: "range", a: node, b: primary() };
      } else if (isOp(" ")) {
        position += 1;
        node = { t: "isect", a: node, b: primary() };
      } else return node;
    }
  };
  const postfix = (): Node => {
    let node = reference();
    while (isOp("%")) {
      position += 1;
      node = { t: "pct", x: node };
    }
    return node;
  };
  // Excel negates before it raises: -2^2 is 4.
  const unary = (): Node => {
    if (isOp("-")) {
      position += 1;
      return { t: "neg", x: unary() };
    }
    if (isOp("+")) {
      position += 1;
      return unary();
    }
    return postfix();
  };
  const power = binary(unary, (op) => op === "^");
  const product = binary(power, (op) => op === "*" || op === "/");
  const sum = binary(product, (op) => op === "+" || op === "-");
  const concat = binary(sum, (op) => op === "&");
  const comparison: () => Node = binary(concat, (op) => COMPARE.has(op));
  const root = comparison();
  if (position !== tokens.length) throw new Unsupported("a formula this engine can't read");
  return root;
}

type Reference = Extract<Node, { t: "ref" | "ref3d" | "name" }>;
/** Every reference and name a formula reads, for the dependency order. */
export function references(node: Node, found: Reference[] = []) {
  switch (node.t) {
    case "ref":
    case "ref3d":
    case "name":
      found.push(node);
      break;
    case "call":
      for (const arg of node.args) references(arg, found);
      break;
    case "neg":
    case "pct":
      references(node.x, found);
      break;
    case "bin":
    case "range":
    case "isect":
      references(node.a, found);
      references(node.b, found);
      break;
    case "union":
      for (const item of node.items) references(item, found);
      break;
    case "arr":
      for (const row of node.rows) for (const item of row) references(item, found);
      break;
    default:
      break;
  }
  return found;
}

/** Whether a formula calls any of `names`, however deeply. */
export function calls(node: Node, names: ReadonlySet<string>): boolean {
  switch (node.t) {
    case "call":
      return names.has(node.name) || node.args.some((arg) => calls(arg, names));
    case "neg":
    case "pct":
      return calls(node.x, names);
    case "bin":
    case "range":
    case "isect":
      return calls(node.a, names) || calls(node.b, names);
    case "union":
      return node.items.some((item) => calls(item, names));
    case "arr":
      return node.rows.some((row) => row.some((item) => calls(item, names)));
    default:
      return false;
  }
}
