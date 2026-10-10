import { columnIndex, columnLetters, MAX_COLUMN, MAX_ROW } from "@chat/sheet/a1";
import { parseFormula, type Node } from "@chat/sheet/engine/parse";

/**
 * Functions newer than Excel 2007 are stored with a namespace prefix. Without
 * it Excel shows #NAME? for a formula it would otherwise compute, so a formula
 * the model writes gets the prefix on the way into the file, and loses it on
 * the way into the calculation engine.
 */
const FUTURE_FUNCTIONS = new Map(
  [
    "ACOT",
    "ACOTH",
    "AGGREGATE",
    "ANCHORARRAY",
    "ARABIC",
    "ARRAYTOTEXT",
    "BASE",
    "BETA.DIST",
    "BETA.INV",
    "BINOM.DIST",
    "BINOM.DIST.RANGE",
    "BINOM.INV",
    "BITAND",
    "BITLSHIFT",
    "BITOR",
    "BITRSHIFT",
    "BITXOR",
    "BYCOL",
    "BYROW",
    "CEILING.MATH",
    "CEILING.PRECISE",
    "CHISQ.DIST",
    "CHISQ.DIST.RT",
    "CHISQ.INV",
    "CHISQ.INV.RT",
    "CHISQ.TEST",
    "CHOOSECOLS",
    "CHOOSEROWS",
    "COMBINA",
    "CONCAT",
    "CONFIDENCE.NORM",
    "CONFIDENCE.T",
    "COT",
    "COTH",
    "COVARIANCE.P",
    "COVARIANCE.S",
    "CSC",
    "CSCH",
    "DAYS",
    "DECIMAL",
    "DROP",
    "ENCODEURL",
    "ERF.PRECISE",
    "ERFC.PRECISE",
    "EXPAND",
    "EXPON.DIST",
    "F.DIST",
    "F.DIST.RT",
    "F.INV",
    "F.INV.RT",
    "F.TEST",
    "FILTERXML",
    "FLOOR.MATH",
    "FLOOR.PRECISE",
    "FORECAST.ETS",
    "FORECAST.ETS.CONFINT",
    "FORECAST.ETS.SEASONALITY",
    "FORECAST.ETS.STAT",
    "FORECAST.LINEAR",
    "FORMULATEXT",
    "GAMMA",
    "GAMMA.DIST",
    "GAMMA.INV",
    "GAMMALN.PRECISE",
    "GAUSS",
    "HSTACK",
    "HYPGEOM.DIST",
    "IFNA",
    "IFS",
    "IMCOSH",
    "IMCOT",
    "IMCSC",
    "IMCSCH",
    "IMSEC",
    "IMSECH",
    "IMSINH",
    "IMTAN",
    "ISFORMULA",
    "ISOMITTED",
    "ISOWEEKNUM",
    "LAMBDA",
    "LET",
    "LOGNORM.DIST",
    "LOGNORM.INV",
    "MAKEARRAY",
    "MAP",
    "MAXIFS",
    "MINIFS",
    "MODE.MULT",
    "MODE.SNGL",
    "MUNIT",
    "NEGBINOM.DIST",
    "NETWORKDAYS.INTL",
    "NORM.DIST",
    "NORM.INV",
    "NORM.S.DIST",
    "NORM.S.INV",
    "NUMBERVALUE",
    "PDURATION",
    "PERCENTILE.EXC",
    "PERCENTILE.INC",
    "PERCENTRANK.EXC",
    "PERCENTRANK.INC",
    "PERMUTATIONA",
    "PHI",
    "POISSON.DIST",
    "QUARTILE.EXC",
    "QUARTILE.INC",
    "RANDARRAY",
    "RANK.AVG",
    "RANK.EQ",
    "REDUCE",
    "RRI",
    "SCAN",
    "SEC",
    "SECH",
    "SEQUENCE",
    "SHEET",
    "SHEETS",
    "SINGLE",
    "SKEW.P",
    "SORTBY",
    "STDEV.P",
    "STDEV.S",
    "SWITCH",
    "T.DIST",
    "T.DIST.2T",
    "T.DIST.RT",
    "T.INV",
    "T.INV.2T",
    "T.TEST",
    "TAKE",
    "TEXTAFTER",
    "TEXTBEFORE",
    "TEXTJOIN",
    "TEXTSPLIT",
    "TOCOL",
    "TOROW",
    "UNICHAR",
    "UNICODE",
    "UNIQUE",
    "VALUETOTEXT",
    "VAR.P",
    "VAR.S",
    "VSTACK",
    "WEBSERVICE",
    "WEIBULL.DIST",
    "WORKDAY.INTL",
    "WRAPCOLS",
    "WRAPROWS",
    "XLOOKUP",
    "XMATCH",
    "XOR",
    "Z.TEST",
  ].map((name) => [name, "_xlfn."]),
);
// FILTER and SORT live one namespace further in.
for (const name of ["FILTER", "SORT"]) FUTURE_FUNCTIONS.set(name, "_xlfn._xlws.");

/**
 * Runs `transform` on each part of a formula outside string literals and
 * quoted sheet names, so text like "A1" inside quotes is never touched.
 */
function outsideQuotes(formula: string, transform: (code: string) => string) {
  let output = "";
  let code = "";
  for (let index = 0; index < formula.length; index++) {
    const character = formula[index]!;
    if (character !== '"' && character !== "'") {
      code += character;
      continue;
    }
    output += transform(code);
    code = "";
    let end = index + 1;
    while (end < formula.length) {
      if (formula[end] === character && formula[end + 1] === character) end += 2;
      else if (formula[end] === character) break;
      else end += 1;
    }
    output += formula.slice(index, end + 1);
    index = end;
  }
  return output + transform(code);
}

/** Names LET and LAMBDA bind, which the file stores as `_xlpm.name`. */
function boundNames(node: Node, found = new Set<string>()): Set<string> {
  if (node.t === "call") {
    node.args.forEach((arg, index) => {
      const binds =
        node.name === "LET"
          ? index % 2 === 0 && index < node.args.length - 1
          : node.name === "LAMBDA" && index < node.args.length - 1;
      if (binds && arg.t === "name") found.add(arg.name.toLowerCase());
    });
    for (const arg of node.args) boundNames(arg, found);
  } else if (node.t === "neg" || node.t === "pct") boundNames(node.x, found);
  else if (node.t === "bin" || node.t === "range" || node.t === "isect") {
    boundNames(node.a, found);
    boundNames(node.b, found);
  } else if (node.t === "union") for (const item of node.items) boundNames(item, found);
  return found;
}

const SHEET_PREFIX = String.raw`(?:(?:'(?:[^']|'')+'|[A-Za-z_À-￿][\w.À-￿]*)!)?`;
const REFERENCE = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?`;
const spillReference = new RegExp(`${SHEET_PREFIX}\\$?[A-Za-z]{1,3}\\$?\\d{1,7}(?=#)`, "y");
const singleOperand = new RegExp(`${SHEET_PREFIX}(?:${REFERENCE}|[A-Za-z_\\\\][\\w.]*)`, "y");

/** Where the string literal or bracketed part starting at `index` ends. */
function skipQuoted(text: string, index: number) {
  const close = text[index] === "[" ? "]" : text[index]!;
  let depth = 0;
  for (let end = index; end < text.length; end++) {
    if (text[end] === '"' && close !== '"') {
      end = skipQuoted(text, end) - 1;
      continue;
    }
    if (close === "]" && text[end] === "[") depth += 1;
    else if (text[end] === close && (close !== "]" || --depth === 0)) {
      if (close !== "]" && text[end + 1] === close) {
        end += 1;
        continue;
      }
      if (end > index || close === "]") return end + 1;
    }
  }
  return text.length;
}

/**
 * Excel 365's typed shorthands have no file form: `A1#` is stored as
 * `_xlfn.ANCHORARRAY(A1)` and `@x` as `_xlfn.SINGLE(x)`. Strings and table
 * brackets (where `[@Column]` means this row) are left alone.
 */
function expandShorthands(text: string): string {
  let output = "";
  for (let index = 0; index < text.length;) {
    const character = text[index]!;
    if (character === '"' || character === "[") {
      const end = skipQuoted(text, index);
      output += text.slice(index, end);
      index = end;
      continue;
    }
    const before = text[index - 1];
    if (!before || !/[\w.$'!\]]/.test(before)) {
      spillReference.lastIndex = index;
      const spill = spillReference.exec(text);
      if (spill) {
        output += `_xlfn.ANCHORARRAY(${spill[0]})`;
        index += spill[0].length + 1;
        continue;
      }
    }
    if (character === "@") {
      let end = index + 1;
      if (text[end] === "(") end = matchingParen(text, end);
      else {
        singleOperand.lastIndex = end;
        const operand = singleOperand.exec(text);
        if (operand) {
          end += operand[0].length;
          if (text[end] === "(") end = matchingParen(text, end);
        }
      }
      if (end > index + 1) {
        output += `_xlfn.SINGLE(${expandShorthands(text.slice(index + 1, end))})`;
        index = end;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  return output;
}
/** Just past the parenthesis closing the one at `index`, strings skipped. */
function matchingParen(text: string, index: number) {
  let depth = 0;
  for (let end = index; end < text.length; end++) {
    if (text[end] === '"' || text[end] === "[") {
      end = skipQuoted(text, end) - 1;
      continue;
    }
    if (text[end] === "(") depth += 1;
    else if (text[end] === ")" && --depth === 0) return end + 1;
  }
  return text.length;
}

/** Structured references as plain cells, for reading names only: the tables themselves are unknown here. */
function withoutTables(text: string) {
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === '"') {
      const end = skipQuoted(text, index);
      output += text.slice(index, end);
      index = end;
    } else if (text[index] === "[") {
      output = output.replace(/[A-Za-z_\\][\w.]*$/, "") + "A1";
      index = skipQuoted(text, index);
    } else output += text[index++];
  }
  return output;
}

/**
 * A formula as the file stores it: no leading "=", Excel 365 shorthands
 * spelled out, future functions and LET and LAMBDA names prefixed.
 */
export function toFileFormula(text: string) {
  const stored = outsideQuotes(expandShorthands(text.replace(/^=/, "")), (code) =>
    code.replace(/(?<![\w.])([A-Z][A-Z0-9.]*)(?=\s*\()/gi, (name: string) => {
      const prefix = FUTURE_FUNCTIONS.get(name.toUpperCase());
      return prefix ? prefix + name.toUpperCase() : name;
    }),
  );
  if (!/\b(?:LET|LAMBDA)\s*\(/i.test(stored)) return stored;
  let names: Set<string>;
  try {
    names = boundNames(parseFormula(withoutTables(stored)));
  } catch {
    return stored;
  }
  if (!names.size) return stored;
  // Not a function, sheet or table name, and not a column inside a table's brackets.
  return outsideQuotes(stored, (code) =>
    code.replace(/(?<![\w.$\][@])([A-Za-z_\\][\w.]*)(?![\w.]*\s*[(![\]])/g, (name: string) =>
      names.has(name.toLowerCase()) ? `_xlpm.${name}` : name,
    ),
  );
}

/** A stored formula as the calculation engine reads it: "=" and no namespaces. */
export const toEngineFormula = (stored: string) =>
  `=${outsideQuotes(stored, (code) => code.replace(/_xlfn\.(?:_xlws\.)?|_xlpm\./gi, ""))}`;

/** A sheet name as a reference writes it: quoted unless it is a plain identifier. */
export const quoteSheet = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name)
    ? name
    : `'${name.replaceAll("'", "''")}'`;

/**
 * Points references at a renamed sheet: `Old!A1` and `'Old Name'!A1`, never
 * text inside a string literal.
 */
export function renameSheetInFormula(formula: string, from: string, to: string) {
  const quoted = `'${from.replaceAll("'", "''")}'!`;
  const target = `${quoteSheet(to)}!`;
  let output = "";
  for (let index = 0; index < formula.length;) {
    const character = formula[index]!;
    if (character === '"') {
      let end = index + 1;
      while (end < formula.length && !(formula[end] === '"' && formula[end + 1] !== '"'))
        end += formula[end] === '"' ? 2 : 1;
      output += formula.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    // Sheet names match case-insensitively, as Excel's do.
    if (
      character === "'" &&
      formula.slice(index, index + quoted.length).toLowerCase() === quoted.toLowerCase()
    ) {
      output += target;
      index += quoted.length;
      continue;
    }
    const before = formula[index - 1];
    if (
      (before === undefined || !/[\w.'$]/.test(before)) &&
      formula.slice(index, index + from.length + 1).toLowerCase() === `${from.toLowerCase()}!`
    ) {
      output += target;
      index += from.length + 1;
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/**
 * A shared formula's text moved from its master cell to another member of the
 * group: relative parts of each reference shift, `$`-anchored ones stay.
 * Function names (a name followed by "(") and sheet names (followed by "!")
 * look like references and are left alone.
 */
export function shiftFormula(formula: string, rows: number, columns: number) {
  if (rows === 0 && columns === 0) return formula;
  const shiftRow = (anchored: string, row: string) =>
    anchored ? row : String(Math.min(MAX_ROW, Math.max(1, Number(row) + rows)));
  const shiftColumn = (anchored: string, letters: string) =>
    anchored
      ? letters
      : columnLetters(
          Math.min(MAX_COLUMN, Math.max(1, columnIndex(letters.toUpperCase()) + columns)),
        );
  return outsideQuotes(formula, (code) =>
    code.replace(
      /(?<![\w.$])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![\w(!])/gi,
      (_match, columnAnchor: string, letters: string, rowAnchor: string, row: string) =>
        `${columnAnchor}${shiftColumn(columnAnchor, letters)}${rowAnchor}${shiftRow(rowAnchor, row)}`,
    ),
  );
}
