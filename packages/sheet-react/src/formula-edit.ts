import { functionNames } from "@chat/sheet/engine/functions";
import { lex } from "@chat/sheet/engine/parse";
import { delocalizeFormula } from "@chat/sheet/formula-locale";
import type { SheetLocale } from "@chat/sheet/locales";
import { isCommon } from "./formula-help.ts";

/**
 * What the cell editor knows about a formula while it is typed: where its
 * references are, which function the caret is in, what name is being typed,
 * and how pointing at cells or F4 rewrites it. Plain text in, text and caret
 * out, so it is tested without a grid.
 */

export interface FormulaRef {
  /** Offsets into the typed text, "=" included. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
  /** The sheet it names, or null for the sheet being edited. */
  readonly sheet: string | null;
  /** Rows and columns from 1; a whole row or column leaves the other null. */
  readonly top: number | null;
  readonly left: number | null;
  readonly bottom: number | null;
  readonly right: number | null;
}

/**
 * Typed text in English syntax, for reading only. Every separator the locale changes is one
 * character for one, so each offset into it is the same offset into what was typed.
 */
const english = (text: string, locale: SheetLocale | undefined) =>
  locale ? delocalizeFormula(text, locale) : text;

/** The references in a typed formula, in order; none in plain text. */
export function formulaRefs(text: string, locale?: SheetLocale): FormulaRef[] {
  if (!text.startsWith("=")) return [];
  const refs: FormulaRef[] = [];
  let offset = 1;
  for (const piece of lex(english(text, locale).slice(1))) {
    if (piece.k === "ref") {
      const to = piece.to ?? piece.from;
      refs.push({
        start: offset,
        end: offset + piece.text.length,
        text: piece.text,
        sheet: piece.sheets ? piece.sheets.first : piece.sheet,
        top: piece.from.row === null || to.row === null ? null : Math.min(piece.from.row, to.row),
        bottom:
          piece.from.row === null || to.row === null ? null : Math.max(piece.from.row, to.row),
        left:
          piece.from.column === null || to.column === null
            ? null
            : Math.min(piece.from.column, to.column),
        right:
          piece.from.column === null || to.column === null
            ? null
            : Math.max(piece.from.column, to.column),
      });
    }
    offset += piece.text.length;
  }
  return refs;
}

/** Whether `index` falls inside a quoted string of the formula. */
const inString = (text: string, index: number) => {
  let quoted = false;
  for (let at = 0; at < index; at++) if (text[at] === '"') quoted = !quoted;
  return quoted;
};
/** Characters after which a reference or a function may start; a backslash splits a localized array's columns. */
const OPENERS = new Set(["=", "(", ",", ";", "\\", "+", "-", "*", "/", "^", "&", "<", ">", ":", " "]);

/** The function name being typed before the caret, and the names it could become. */
export function completion(
  text: string,
  caret: number,
  names: readonly string[],
): { start: number; prefix: string; matches: string[] } | null {
  if (!text.startsWith("=") || inString(text, caret)) return null;
  const typed = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(text.slice(1, caret));
  if (!typed) return null;
  const start = caret - typed[0].length;
  if (!OPENERS.has(text[start - 1]!)) return null;
  // A name followed by "(" is already a call; one that reads as a cell is a reference.
  if (text[caret] === "(" || /^[A-Za-z]{1,3}\d+$/.test(typed[0])) return null;
  const prefix = typed[0].toUpperCase();
  // The typed name itself first, then the functions people use most, shortest first.
  const rank = (name: string) => [name === prefix ? 0 : 1, isCommon(name) ? 0 : 1, name.length];
  const matches = names
    .filter((name) => name.startsWith(prefix))
    .toSorted((a, b) => {
      const [x, y] = [rank(a), rank(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]! || a.localeCompare(b);
    })
    .slice(0, 8);
  return matches.length ? { start, prefix, matches } : null;
}

/** A chosen function written in place of the typed name, the caret inside its parentheses. */
export function acceptCompletion(text: string, caret: number, start: number, name: string) {
  const before = text.slice(0, start);
  const after = text.slice(caret);
  const call = after.startsWith("(") ? name : `${name}(`;
  return { text: `${before}${call}${after}`, caret: before.length + name.length + 1 };
}

/**
 * The innermost call the caret is in, and which of its arguments, counting from 0. Read in
 * English syntax, so a localized decimal comma or an array's separators start no argument.
 */
export function callAt(
  typed: string,
  caret: number,
  locale?: SheetLocale,
): { name: string; argument: number } | null {
  if (!typed.startsWith("=")) return null;
  const text = english(typed, locale);
  const stack: Array<{ name: string; argument: number }> = [];
  let quoted = false;
  let braces = 0;
  for (let at = 1; at < caret; at++) {
    const char = text[at]!;
    if (char === '"') quoted = !quoted;
    if (quoted) continue;
    if (char === "{") braces++;
    else if (char === "}") braces = Math.max(0, braces - 1);
    else if (char === "(") {
      const name = /([A-Za-z_][A-Za-z0-9_.]*)$/.exec(text.slice(1, at))?.[1] ?? "";
      stack.push({ name: name.toUpperCase(), argument: 0 });
    } else if (char === ")") stack.pop();
    else if (char === "," && !braces && stack.length) stack.at(-1)!.argument++;
  }
  const inner = stack.at(-1);
  return inner?.name ? inner : null;
}

/** Whether a click on a cell should write its reference at the caret, as Excel's point mode does. */
export function pointable(text: string, caret: number) {
  if (!text.startsWith("=") || inString(text, caret)) return false;
  const before = text.slice(0, caret).trimEnd();
  return OPENERS.has(before.at(-1) ?? "");
}

/** A reference written at the caret, or over the one pointing wrote before. */
export function insertRef(
  text: string,
  caret: number,
  ref: string,
  replace: { start: number; end: number } | null,
) {
  const [start, end] = replace ? [replace.start, replace.end] : [caret, caret];
  return {
    text: `${text.slice(0, start)}${ref}${text.slice(end)}`,
    caret: start + ref.length,
    pointed: { start, end: start + ref.length },
  };
}

/** One corner's `$` marks turned on to the next of Excel's four: A1, $A$1, A$1, $A1. */
const cycleCorner = (corner: string) => {
  const match = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(corner);
  if (!match) return corner;
  const [, column, letters, row, digits] = match;
  const next =
    !column && !row
      ? ["$", "$"]
      : column && row
        ? ["", "$"]
        : !column && row
          ? ["$", ""]
          : ["", ""];
  return `${next[0]}${letters}${next[1]}${digits}`;
};

/** F4: the reference at the caret with its `$` marks cycled, or null when there is none. */
export function toggleAbsolute(text: string, caret: number, locale?: SheetLocale) {
  const ref = formulaRefs(text, locale).find((each) => caret >= each.start && caret <= each.end);
  if (!ref) return null;
  const bang = ref.text.lastIndexOf("!");
  const sheet = bang === -1 ? "" : ref.text.slice(0, bang + 1);
  const area = ref.text.slice(sheet.length).split(":").map(cycleCorner).join(":");
  const replaced = `${sheet}${area}`;
  return {
    text: `${text.slice(0, ref.start)}${replaced}${text.slice(ref.end)}`,
    caret: ref.start + replaced.length,
  };
}

/** Functions offered while typing; the engine's internal ones are left out. */
const NAMES = functionNames().filter((name) => name !== "ANCHORARRAY");

/** Colours references take in a formula being typed, in turn, as Excel colours them. */
export const REF_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--chart-4)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
];

/** The function names a formula's caret could complete, or null. */
export const completionFor = (text: string, caret: number) => completion(text, caret, NAMES);
