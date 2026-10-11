import { clockOf, MAX_SERIAL, partsOf, weekdayOf } from "./dates.ts";
import { EN_US, type SheetLocale } from "./locales.ts";

/**
 * Excel number format codes, written as Excel writes them in a locale: the
 * code itself is locale-free (`.` decimal, `,` thousands), and the locale
 * supplies separators and names. Grid display and the TEXT function share it.
 */

export interface Formatted {
  readonly text: string;
  /** A section's colour, such as "red" from `[Red]`. */
  readonly color?: string;
}

type Token =
  | { readonly t: "lit"; readonly s: string; readonly bare?: true }
  | { readonly t: "digit"; readonly c: "0" | "#" | "?" }
  | { readonly t: "point" | "comma" | "percent" | "slash" | "text" | "general" }
  | { readonly t: "exp"; readonly plus: boolean }
  | { readonly t: "date"; readonly k: "y" | "m" | "d" | "h" | "s" | "min"; readonly n: number }
  | { readonly t: "elapsed"; readonly k: "h" | "m" | "s"; readonly n: number }
  | { readonly t: "ampm"; readonly short: boolean; readonly lower: boolean }
  | { readonly t: "subsec"; readonly n: number };

interface Condition {
  readonly op: "<" | ">" | "=" | "<=" | ">=" | "<>";
  readonly value: number;
}
interface Section {
  readonly tokens: readonly Token[];
  readonly color?: string;
  readonly condition?: Condition;
  readonly date: boolean;
}

const COLORS: Record<string, string> = {
  black: "black",
  blue: "blue",
  cyan: "cyan",
  green: "green",
  magenta: "magenta",
  red: "red",
  white: "white",
  yellow: "yellow",
};

/** Splits at `;` outside quotes, brackets and escapes. */
function sections(code: string): string[] {
  const out: string[] = [];
  let current = "";
  for (let index = 0; index < code.length; index++) {
    const character = code[index]!;
    if (character === '"') {
      const end = code.indexOf('"', index + 1);
      const stop = end === -1 ? code.length : end;
      current += code.slice(index, stop + 1);
      index = stop;
    } else if (character === "\\" || character === "_" || character === "*") {
      current += code.slice(index, index + 2);
      index++;
    } else if (character === "[") {
      const end = code.indexOf("]", index);
      const stop = end === -1 ? code.length - 1 : end;
      current += code.slice(index, stop + 1);
      index = stop;
    } else if (character === ";") {
      out.push(current);
      current = "";
    } else current += character;
  }
  out.push(current);
  return out;
}

function bracket(
  content: string,
  section: { color?: string; condition?: Condition },
): Token | null {
  const lower = content.toLowerCase();
  if (COLORS[lower]) section.color = COLORS[lower];
  else if (/^color\d+$/.test(lower)) section.color = lower;
  else if (/^(<=|>=|<>|<|>|=)/.test(content)) {
    const match = /^(<=|>=|<>|<|>|=)\s*(-?\d+(?:\.\d+)?)$/.exec(content);
    if (match) section.condition = { op: match[1] as Condition["op"], value: Number(match[2]) };
  } else if (content.startsWith("$")) {
    // [$€-407]: the symbol before the dash is shown; the rest names a locale.
    const symbol = content.slice(1).split("-")[0]!;
    if (symbol) return { t: "lit", s: symbol };
  } else if (/^(h+|m+|s+)$/i.test(content))
    return { t: "elapsed", k: lower[0] as "h" | "m" | "s", n: content.length };
  return null;
}

function tokenize(code: string): Section {
  const tokens: Token[] = [];
  const section: { color?: string; condition?: Condition } = {};
  const run = (from: number, letter: string) => {
    let end = from;
    while (end < code.length && code[end]!.toLowerCase() === letter) end++;
    return end - from;
  };
  for (let index = 0; index < code.length; index++) {
    const character = code[index]!;
    const lower = character.toLowerCase();
    const rest = code.slice(index);
    if (character === '"') {
      const end = code.indexOf('"', index + 1);
      const stop = end === -1 ? code.length : end;
      tokens.push({ t: "lit", s: code.slice(index + 1, stop) });
      index = stop;
    } else if (character === "\\") {
      if (index + 1 < code.length) tokens.push({ t: "lit", s: code[index + 1]! });
      index++;
    } else if (character === "_") {
      // Room the width of the next character: a space is the nearest text.
      tokens.push({ t: "lit", s: " " });
      index++;
    } else if (character === "*") {
      // A fill to the cell's width: nothing in text.
      index++;
    } else if (character === "[") {
      const end = code.indexOf("]", index);
      const stop = end === -1 ? code.length - 1 : end;
      const token = bracket(code.slice(index + 1, stop), section);
      if (token) tokens.push(token);
      index = stop;
    } else if (/^general/i.test(rest)) {
      tokens.push({ t: "general" });
      index += 6;
    } else if (/^am\/pm/i.test(rest)) {
      tokens.push({ t: "ampm", short: false, lower: false });
      index += 4;
    } else if (/^a\/p/i.test(rest)) {
      tokens.push({ t: "ampm", short: true, lower: character === "a" });
      index += 2;
    } else if (lower === "e" && (code[index + 1] === "+" || code[index + 1] === "-")) {
      tokens.push({ t: "exp", plus: code[index + 1] === "+" });
      index++;
    } else if ("ymdhs".includes(lower)) {
      const n = run(index, lower);
      tokens.push({ t: "date", k: lower as "y" | "m" | "d" | "h" | "s", n });
      index += n - 1;
    } else if (character === "0" || character === "#" || character === "?")
      tokens.push({ t: "digit", c: character });
    else if (character === ".") tokens.push({ t: "point" });
    else if (character === ",") tokens.push({ t: "comma" });
    else if (character === "%") tokens.push({ t: "percent" });
    else if (character === "/") tokens.push({ t: "slash" });
    else if (character === "@") tokens.push({ t: "text" });
    else tokens.push({ t: "lit", s: character, bare: true });
  }
  const date = tokens.some(
    (token) => token.t === "date" || token.t === "elapsed" || token.t === "ampm",
  );
  return { tokens: date ? dateTokens(tokens) : tokens, date, ...section };
}

/** In a date section: minutes from months, fractional seconds, and the locale's separators later. */
function dateTokens(tokens: Token[]): Token[] {
  const timed = tokens.filter((token) => token.t === "date" || token.t === "elapsed");
  const out: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.t === "date" && token.k === "m") {
      const at = timed.indexOf(token);
      const before = timed[at - 1];
      const after = timed[at + 1];
      const hourBefore = before && (before.t === "elapsed" ? before.k === "h" : before.k === "h");
      const secondAfter = after && (after.t === "elapsed" ? after.k === "s" : after.k === "s");
      out.push(hourBefore || secondAfter ? { t: "date", k: "min", n: token.n } : token);
    } else if (token.t === "point" && tokens[index + 1]?.t === "digit") {
      let n = 0;
      while (tokens[index + 1 + n]?.t === "digit") n++;
      out.push({ t: "subsec", n });
      index += n;
    } else out.push(token);
  }
  return out;
}

interface Parsed {
  readonly sections: readonly Section[];
}
const cache = new Map<string, Parsed>();
function parse(code: string): Parsed {
  const hit = cache.get(code);
  if (hit) return hit;
  const parsed = { sections: sections(code).map(tokenize) };
  // Codes come from cells; a sheet holds few, so a full cache is simply restarted.
  if (cache.size > 500) cache.clear();
  cache.set(code, parsed);
  return parsed;
}

const compareTo = (value: number, condition: Condition) => {
  switch (condition.op) {
    case "<":
      return value < condition.value;
    case ">":
      return value > condition.value;
    case "=":
      return value === condition.value;
    case "<=":
      return value <= condition.value;
    case ">=":
      return value >= condition.value;
    default:
      return value !== condition.value;
  }
};

/** The section a number uses, and whether it writes the sign itself. */
function pick(all: readonly Section[], value: number): { section: Section; signed: boolean } {
  const numeric = all.slice(0, 3);
  if (numeric.some((section) => section.condition)) {
    for (const section of numeric)
      if (section.condition && compareTo(value, section.condition))
        return { section, signed: value < 0 && !section.condition };
    const fallback = numeric.find((section) => !section.condition) ?? numeric.at(-1)!;
    return { section: fallback, signed: value < 0 };
  }
  if (numeric.length === 1 || value > 0) return { section: numeric[0]!, signed: value < 0 };
  if (value < 0) return { section: numeric[1]!, signed: false };
  return { section: numeric[2] ?? numeric[0]!, signed: false };
}

/** 15 significant digits, then half away from zero at `places`, as Excel rounds. */
export function roundAt(value: number, places: number) {
  const significant = value === 0 ? 0 : Number(value.toPrecision(15));
  const factor = 10 ** places;
  const scaled = Number((Math.abs(significant) * factor).toPrecision(15));
  return (Math.sign(significant) * Math.round(scaled)) / factor;
}

/** A non-negative number's integer and fraction digits, without exponent notation. */
function digitsOf(value: number, places: number): { whole: string; fraction: string } {
  const fixed =
    value < 1e21
      ? value.toFixed(places)
      : BigInt(Math.round(value)).toString() + (places ? `.${"0".repeat(places)}` : "");
  const [whole, fraction = ""] = fixed.split(".");
  return { whole: whole === "0" ? "" : whole!, fraction };
}

const isDigit = (token: Token | undefined): token is { t: "digit"; c: "0" | "#" | "?" } =>
  token?.t === "digit";

/** Integer placeholders and literals, filled with `whole` right to left. */
function integerPart(
  tokens: readonly Token[],
  whole: string,
  grouping: boolean,
  locale: SheetLocale,
) {
  const placeholders = tokens.filter(isDigit);
  const n = placeholders.length;
  const k = whole.length;
  let seen = 0;
  let out = "";
  const emit = (digit: string, position: number) => {
    out += digit;
    if (grouping && position > 0 && position % 3 === 0 && digit !== " ") out += locale.group;
  };
  // No placeholder at all (".00"): the whole part still shows, ahead of everything.
  if (n === 0) for (let index = 0; index < k; index++) emit(whole[index]!, k - 1 - index);
  for (const token of tokens) {
    if (token.t === "lit") {
      out += token.s;
      continue;
    }
    if (token.t !== "digit") continue;
    const fromRight = n - 1 - seen;
    if (seen === 0) for (let extra = 0; extra < k - n; extra++) emit(whole[extra]!, k - 1 - extra);
    if (fromRight < k) emit(whole[k - 1 - fromRight]!, fromRight);
    else if (token.c === "0") emit("0", fromRight);
    else if (token.c === "?") emit(" ", fromRight);
    seen++;
  }
  return out;
}

/** Fraction placeholders and literals: `#` drops trailing zeros, `?` turns them into spaces. */
function fractionPart(tokens: readonly Token[], fraction: string) {
  const placeholders = tokens.filter(isDigit);
  const shown = [...fraction];
  for (let index = placeholders.length - 1; index >= 0; index--) {
    const kind = placeholders[index]!.c;
    if (kind === "0" || shown[index] !== "0") break;
    shown[index] = kind === "?" ? " " : "";
  }
  let seen = 0;
  let out = "";
  for (const token of tokens) {
    if (token.t === "lit") out += token.s;
    else if (token.t === "digit") out += shown[seen++] ?? "";
  }
  return out;
}

/** `0.00`, `#,##0`, `0%` and the like, with literals anywhere. */
function plainNumber(tokens: readonly Token[], value: number, locale: SheetLocale) {
  const point = tokens.findIndex((token) => token.t === "point");
  const before = point === -1 ? tokens : tokens.slice(0, point);
  const after = point === -1 ? [] : tokens.slice(point + 1);
  // Commas right after the last digit, or just before the point, scale by a
  // thousand each; one between integer digits groups.
  const lastDigit = before.findLastIndex(isDigit);
  let scale = 0;
  for (let index = lastDigit + 1; before[index]?.t === "comma"; index++) scale++;
  if (point !== -1)
    for (let index = after.findLastIndex(isDigit) + 1; after[index]?.t === "comma"; index++)
      scale++;
  const grouping = before.some(
    (token, index) =>
      token.t === "comma" && index < lastDigit && before.slice(0, index).some(isDigit),
  );
  const percents = tokens.filter((token) => token.t === "percent").length;
  const scaled = (Math.abs(value) * 100 ** percents) / 1000 ** scale;
  const places = after.filter(isDigit).length;
  const { whole, fraction } = digitsOf(Math.abs(roundAt(scaled, places)), places);
  const shown = (token: Token) => (token.t === "percent" ? { t: "lit" as const, s: "%" } : token);
  const integer = integerPart(before.map(shown), whole, grouping, locale);
  if (point === -1) return integer;
  return `${integer}${locale.decimal}${fractionPart(after.map(shown), fraction)}`;
}

/** `0.00E+00`, and the engineering form `##0.0E+0`. */
function scientific(tokens: readonly Token[], value: number, locale: SheetLocale) {
  const at = tokens.findIndex((token) => token.t === "exp");
  const mantissa = tokens.slice(0, at);
  const exponentTokens = tokens.slice(at + 1);
  const exp = tokens[at] as { t: "exp"; plus: boolean };
  const point = mantissa.findIndex((token) => token.t === "point");
  const integerSlots = (point === -1 ? mantissa : mantissa.slice(0, point)).filter(isDigit);
  const places = point === -1 ? 0 : mantissa.slice(point + 1).filter(isDigit).length;
  const width = Math.max(1, integerSlots.length);
  const engineering = width > 1 && integerSlots.some((slot) => slot.c === "#");
  const magnitude = Math.abs(value);
  let power = magnitude === 0 ? 0 : Math.floor(Math.log10(magnitude));
  power = engineering ? Math.floor(power / width) * width : power - (width - 1);
  let base = roundAt(magnitude / 10 ** power, places);
  if (base >= 10 ** (engineering ? width : width)) {
    power += engineering ? width : 1;
    base = roundAt(magnitude / 10 ** power, places);
  }
  const exponentDigits = Math.max(1, exponentTokens.filter(isDigit).length);
  const sign = power < 0 ? "-" : exp.plus ? "+" : "";
  const exponent = String(Math.abs(power)).padStart(exponentDigits, "0");
  const literals = exponentTokens
    .filter((token) => token.t === "lit")
    .map((token) => (token as { s: string }).s);
  return `${plainNumber(mantissa, base, locale)}E${sign}${exponent}${literals.join("")}`;
}

/**
 * The last continued-fraction convergent with a denominator below `limit`.
 * Excel stops there rather than searching the fractions between, so 0.14159
 * over two digits is 1/7, though 14/99 is closer.
 */
function closest(value: number, limit: number): [number, number] {
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let x = value;
  for (let step = 0; step < 64; step++) {
    const a = Math.floor(x);
    const [h2, k2] = [a * h1 + h0, a * k1 + k0];
    if (k2 > limit) break;
    [h0, h1, k0, k1] = [h1, h2, k1, k2];
    if (Math.abs(x - a) < 1e-12) break;
    x = 1 / (x - a);
  }
  return [h1, k1];
}

/** `# ?/?`, `# ??/??` and fixed denominators such as `?/8`. */
function fractionNumber(tokens: readonly Token[], value: number, locale: SheetLocale) {
  const slash = tokens.findIndex((token) => token.t === "slash");
  let numeratorStart = slash;
  while (numeratorStart > 0 && isDigit(tokens[numeratorStart - 1])) numeratorStart--;
  const head = tokens.slice(0, numeratorStart);
  const numeratorSlots = tokens.slice(numeratorStart, slash);
  const tail = tokens.slice(slash + 1);
  const fixedDigits = tail.findIndex((token) => !(token.t === "lit" && /^\d$/.test(token.s)));
  const fixedText = tail
    .slice(0, fixedDigits === -1 ? tail.length : fixedDigits)
    .map((token) => (token as { s: string }).s)
    .join("");
  const denominatorSlots = fixedText ? [] : tail.filter(isDigit);
  const after = tail.slice(fixedText ? fixedText.length : denominatorSlots.length);
  const hasWhole = head.some(isDigit);
  const magnitude = Math.abs(value);
  let whole = hasWhole ? Math.trunc(magnitude) : 0;
  const part = magnitude - whole;
  let [numerator, denominator] = fixedText
    ? [Math.round(part * Number(fixedText)), Number(fixedText)]
    : closest(part, 10 ** Math.max(1, denominatorSlots.length) - 1);
  if (hasWhole && numerator === denominator) {
    whole += 1;
    numerator = 0;
  }
  const headText = integerPart(head, whole === 0 ? "" : String(whole), false, locale);
  if (hasWhole && numerator === 0) {
    // A whole number keeps the fraction's room as spaces, so a column still lines up.
    const room =
      numeratorSlots.length + 1 + (fixedText ? fixedText.length : denominatorSlots.length);
    return `${headText}${" ".repeat(room)}`;
  }
  const top = integerPart(numeratorSlots, String(numerator), false, locale);
  const bottom = fixedText || String(denominator).padEnd(denominatorSlots.length, " ");
  return `${headText}${top}/${bottom}${after.map((token) => (token.t === "lit" ? token.s : "")).join("")}`;
}

/** How many significant digits a number shows, at fifteen at most. */
const significant = (number: number) =>
  number === 0
    ? 0
    : Number(number.toPrecision(15)).toExponential().split("e")[0]!.replace(/[.-]/g, "").length;

/** Excel's General: about eleven characters, switching to scientific form for very large or small numbers. */
export function generalText(value: number, locale: SheetLocale = EN_US): string {
  if (value === 0) return "0";
  const magnitude = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  // Decimal form when it shows as many significant digits as scientific
  // form would (six at most): 0.000001 stays, 0.0000001234 does not.
  const decimal = magnitude < 1 ? roundAt(magnitude, 9) : magnitude;
  const small = magnitude < 1 && significant(decimal) < Math.min(significant(magnitude), 6);
  if (magnitude >= 1e11 || small) {
    let power = Math.floor(Math.log10(magnitude));
    let base = roundAt(magnitude / 10 ** power, 5);
    if (base >= 10) {
      power += 1;
      base = roundAt(magnitude / 10 ** power, 5);
    }
    const mantissa = String(base).replace(".", locale.decimal);
    return `${sign}${mantissa}E${power < 0 ? "-" : "+"}${String(Math.abs(power)).padStart(2, "0")}`;
  }
  const integerDigits = Math.max(1, Math.floor(Math.log10(magnitude)) + 1);
  const places = Math.max(0, 10 - integerDigits);
  const rounded = roundAt(magnitude, places);
  const { whole, fraction } = digitsOf(rounded, places);
  const trimmed = fraction.replace(/0+$/, "");
  return `${sign}${whole || "0"}${trimmed ? locale.decimal + trimmed : ""}`;
}

/** A date, a time or both; null when the serial is outside Excel's calendar. */
function dateText(tokens: readonly Token[], serial: number, locale: SheetLocale): string | null {
  if (serial < 0) return null;
  const subsec = tokens.find((token) => token.t === "subsec") as { n: number } | undefined;
  const unit = 86_400 * 10 ** (subsec?.n ?? 0);
  const rounded = Math.round(serial * unit) / unit;
  const parts = partsOf(rounded);
  if (!parts || rounded > MAX_SERIAL + 1) return null;
  // Shown with a fraction, whole seconds are cut, not rounded: 1.5 s is "01.5".
  const daySeconds = (rounded - Math.floor(rounded)) * 86_400;
  const whole = subsec ? Math.floor(daySeconds + 1e-9) : Math.round(daySeconds);
  const clock = subsec
    ? {
        hour: Math.floor(whole / 3600) % 24,
        minute: Math.floor(whole / 60) % 60,
        second: whole % 60,
      }
    : clockOf(rounded);
  const twelve = tokens.some((token) => token.t === "ampm");
  const seconds = rounded * 86_400;
  let out = "";
  for (const token of tokens) {
    switch (token.t) {
      case "lit":
        out += token.bare && token.s === ":" ? locale.timeSeparator : token.s;
        break;
      case "slash":
        out += locale.dateSeparator;
        break;
      case "comma":
        out += ",";
        break;
      case "point":
        out += ".";
        break;
      case "percent":
        out += "%";
        break;
      case "date":
        switch (token.k) {
          case "y":
            out += token.n <= 2 ? String(parts.year % 100).padStart(2, "0") : String(parts.year);
            break;
          case "m":
            out +=
              token.n === 1
                ? String(parts.month)
                : token.n === 2
                  ? String(parts.month).padStart(2, "0")
                  : token.n === 3
                    ? locale.monthsShort[parts.month - 1]!
                    : token.n === 4
                      ? locale.months[parts.month - 1]!
                      : locale.months[parts.month - 1]![0]!;
            break;
          case "d":
            out +=
              token.n <= 2
                ? String(parts.day).padStart(token.n, "0")
                : token.n === 3
                  ? locale.daysShort[weekdayOf(rounded)]!
                  : locale.days[weekdayOf(rounded)]!;
            break;
          case "h": {
            const hour = twelve ? clock.hour % 12 || 12 : clock.hour;
            out += String(hour).padStart(Math.min(token.n, 2), "0");
            break;
          }
          case "min":
            out += String(clock.minute).padStart(Math.min(token.n, 2), "0");
            break;
          case "s":
            out += String(clock.second).padStart(Math.min(token.n, 2), "0");
            break;
        }
        break;
      case "elapsed": {
        const total =
          token.k === "h"
            ? Math.floor(seconds / 3600)
            : token.k === "m"
              ? Math.floor(seconds / 60)
              : Math.floor(seconds);
        out += String(total).padStart(token.n, "0");
        break;
      }
      case "ampm": {
        const pm = clock.hour >= 12;
        const word = pm ? locale.pm : locale.am;
        const shown = token.short ? word[0]! : word;
        out += token.lower ? shown.toLowerCase() : shown;
        break;
      }
      case "subsec": {
        const fraction = seconds - Math.floor(seconds);
        out += locale.decimal + String(Math.round(fraction * 10 ** token.n)).padStart(token.n, "0");
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function numberSection(section: Section, value: number, signed: boolean, locale: SheetLocale) {
  const { tokens } = section;
  if (section.date) return dateText(tokens, value, locale);
  if (tokens.some((token) => token.t === "general")) {
    const general = generalText(Math.abs(value), locale);
    return `${signed ? "-" : ""}${tokens.map((token) => (token.t === "general" ? general : token.t === "lit" ? token.s : "")).join("")}`;
  }
  const hasDigits = tokens.some(isDigit);
  const body = !hasDigits
    ? tokens
        .map((token) => (token.t === "lit" ? token.s : token.t === "percent" ? "%" : ""))
        .join("")
    : tokens.some((token) => token.t === "exp")
      ? scientific(tokens, value, locale)
      : tokens.some((token) => token.t === "slash")
        ? fractionNumber(tokens, value, locale)
        : plainNumber(tokens, value, locale);
  // A negative number shown as nothing but zeros takes no sign: -0.4 in "0" is "0".
  return `${signed && /[1-9]/.test(body) ? "-" : ""}${body}`;
}

function textSection(section: Section, text: string) {
  return section.tokens
    .map((token) => (token.t === "text" ? text : token.t === "lit" ? token.s : ""))
    .join("");
}

/**
 * A cell value as a format code shows it in a locale; null when it cannot be
 * shown (a negative date, or a serial past 9999), which a cell draws as `#`s.
 */
export function formatValue(
  value: number | string | boolean | null,
  code: string,
  locale: SheetLocale = EN_US,
): Formatted | null {
  if (value === null) return { text: "" };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  const parsed = parse(code.trim() === "" ? "General" : code);
  if (typeof value === "string") {
    const textual =
      parsed.sections[3] ??
      (parsed.sections.length === 1 &&
      parsed.sections[0]!.tokens.some((token) => token.t === "text")
        ? parsed.sections[0]
        : undefined);
    if (!textual) return { text: value };
    return {
      text: textSection(textual, value),
      ...(textual.color ? { color: textual.color } : {}),
    };
  }
  if (!Number.isFinite(value)) return null;
  const { section, signed } = pick(parsed.sections, value);
  const text = numberSection(section, value, signed, locale);
  if (text === null) return null;
  return { text, ...(section.color ? { color: section.color } : {}) };
}
