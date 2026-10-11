import type { SheetLocale } from "./locales.ts";

/**
 * A formula's separators as a person reads and types them. The document, the
 * engine, the model and Excel files all keep the English form; where the
 * decimal is a comma, the formula bar and the cell editor show and read
 * arguments split by ";", decimals with ",", and array columns split by "\",
 * as Google Sheets does. Function names stay English everywhere.
 */
interface Syntax {
  readonly list: string;
  readonly decimal: string;
  readonly arrayColumn: string;
}

const ENGLISH: Syntax = { list: ",", decimal: ".", arrayColumn: "," };

const syntaxOf = (locale: SheetLocale): Syntax =>
  locale.listSeparator === ","
    ? ENGLISH
    : { list: locale.listSeparator, decimal: locale.decimal, arrayColumn: "\\" };

const NAME_START = /[A-Za-z_$À-￿]/;
const NAME_PART = /[A-Za-z0-9_.$À-￿]/;
const DIGIT = /[0-9]/;

/** Copies a quoted run, its closing quote included, with a doubled quote as an escape. */
const quoted = (text: string, at: number, quote: string) => {
  let end = at + 1;
  while (end < text.length) {
    if (text[end] === quote) {
      if (text[end + 1] === quote) end += 2;
      else return end + 1;
    } else end++;
  }
  return end;
};

/** Copies a structured reference's brackets, nested ones included; "'" escapes the next character. */
const bracketed = (text: string, at: number) => {
  let depth = 0;
  let end = at;
  while (end < text.length) {
    if (text[end] === "'") end++;
    else if (text[end] === "[") depth++;
    else if (text[end] === "]" && --depth === 0) return end + 1;
    end++;
  }
  return end;
};

/**
 * Rewrites separators token by token. Text in quotes, quoted sheet names and
 * a table's brackets pass unchanged; a name (a function, a cell, a defined
 * name) passes whole, so the dot in STDEV.S or the digits of A1 never read
 * as a number.
 */
function translate(text: string, from: Syntax, to: Syntax): string {
  if (from === to) return text;
  let out = "";
  let braces = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === '"' || char === "'") {
      const end = quoted(text, at, char);
      out += text.slice(at, end);
      at = end;
    } else if (char === "[") {
      const end = bracketed(text, at);
      out += text.slice(at, end);
      at = end;
    } else if (NAME_START.test(char)) {
      let end = at + 1;
      while (end < text.length && NAME_PART.test(text[end]!)) end++;
      out += text.slice(at, end);
      at = end;
    } else if (
      DIGIT.test(char) ||
      (char === from.decimal && DIGIT.test(text[at + 1] ?? "") && !NAME_PART.test(out.at(-1) ?? ""))
    ) {
      let end = at;
      while (DIGIT.test(text[end] ?? "")) end++;
      let number = text.slice(at, end);
      if (text[end] === from.decimal && DIGIT.test(text[end + 1] ?? "")) {
        const start = ++end;
        while (DIGIT.test(text[end] ?? "")) end++;
        number += to.decimal + text.slice(start, end);
      }
      const exponent = /^[eE][+-]?[0-9]+/.exec(text.slice(end));
      if (exponent) {
        number += exponent[0];
        end += exponent[0].length;
      }
      out += number;
      at = end;
    } else {
      if (char === "{") braces++;
      else if (char === "}") braces = Math.max(0, braces - 1);
      if (braces && char === from.arrayColumn) out += to.arrayColumn;
      else if (!braces && char === from.list) out += to.list;
      else out += char;
      at++;
    }
  }
  return out;
}

/** A stored (English) formula as a person in this locale reads it. */
export const localizeFormula = (text: string, locale: SheetLocale) =>
  translate(text, ENGLISH, syntaxOf(locale));

/**
 * Formula text typed in this locale, in its stored English form. A "," typed
 * between names out of English habit still separates arguments; between
 * digits it is a decimal, as the locale reads it.
 */
export const delocalizeFormula = (text: string, locale: SheetLocale) =>
  translate(text, syntaxOf(locale), ENGLISH);
