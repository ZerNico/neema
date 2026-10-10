import type { Scalar } from "../engine/values.ts";
import type { SheetValues } from "./calc.ts";
import { shownText } from "./filter.ts";
import { positions, type Box, type SheetDoc } from "./model.ts";
import { isBox, isId, isRecord } from "./check.ts";

/**
 * Data validation, as Excel's Data tab sets it: what a range's cells may
 * hold, a list to pick from or a test on numbers, dates or text length,
 * and what typing something else does. Kept by IDs like every range.
 */
export const VALIDATION_TESTS = [
  "between",
  "notBetween",
  "equal",
  "notEqual",
  "greater",
  "less",
  "greaterOrEqual",
  "lessOrEqual",
] as const;
export type ValidationTest = (typeof VALIDATION_TESTS)[number];
export type ValidationRule =
  /** One of these, typed or picked from the cell's dropdown; from cells when `source` is set. */
  | {
      readonly kind: "list";
      readonly values?: readonly string[];
      readonly source?: { readonly sh: string; readonly box: Box };
    }
  /** A whole number, a decimal, a date (as its serial) or a text's length, passing the test. */
  | {
      readonly kind: "whole" | "decimal" | "date" | "length";
      readonly test: ValidationTest;
      readonly values: readonly [number] | readonly [number, number];
    };

export interface Validation {
  readonly id: string;
  readonly box: Box;
  readonly rule: ValidationRule;
  /** What a wrong entry does: refused, or kept after a warning or a note. */
  readonly onError: "stop" | "warning" | "information";
  /** Said when a wrong entry is typed; Excel's default otherwise. */
  readonly message?: string;
  /** An empty cell passes. */
  readonly allowBlank: boolean;
}

export const VALIDATION_LIMITS = { rules: 200, values: 1_000, text: 255 } as const;

function isRule(rule: unknown): boolean {
  if (!isRecord(rule)) return false;
  if (rule.kind === "list")
    return (
      (rule.values === undefined ||
        (Array.isArray(rule.values) &&
          rule.values.length <= VALIDATION_LIMITS.values &&
          rule.values.every(
            (each) => typeof each === "string" && each.length <= VALIDATION_LIMITS.text,
          ))) &&
      (rule.source === undefined ||
        (isRecord(rule.source) && isId(rule.source.sh) && isBox(rule.source.box))) &&
      (rule.values !== undefined || rule.source !== undefined)
    );
  return (
    (rule.kind === "whole" ||
      rule.kind === "decimal" ||
      rule.kind === "date" ||
      rule.kind === "length") &&
    VALIDATION_TESTS.includes(rule.test as ValidationTest) &&
    Array.isArray(rule.values) &&
    rule.values.length >= 1 &&
    rule.values.length <= 2 &&
    rule.values.every((each) => typeof each === "number" && Number.isFinite(each))
  );
}

/** Whether a list of validations, as an operation carries one, is well formed. */
export function isValidationList(value: unknown): value is readonly Validation[] {
  return (
    Array.isArray(value) &&
    value.length <= VALIDATION_LIMITS.rules &&
    value.every(
      (each) =>
        isRecord(each) &&
        isId(each.id) &&
        isBox(each.box) &&
        isRule(each.rule) &&
        (each.onError === "stop" || each.onError === "warning" || each.onError === "information") &&
        typeof each.allowBlank === "boolean" &&
        (each.message === undefined ||
          (typeof each.message === "string" && each.message.length <= VALIDATION_LIMITS.text)),
    )
  );
}

/**
 * A sheet's rules with an area taken out, as Excel clears validation from
 * exactly the cells chosen: a rule partly over the area keeps the rest of its
 * cells, as up to four rules around it. `area` is by position, 1-based.
 */
export function withoutArea(
  doc: SheetDoc,
  sheet: string,
  area: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  },
  mint: () => string,
): Validation[] {
  const data = doc.sheet[sheet]!;
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  return (data.validations ?? []).flatMap((rule) => {
    const [top, bottom, left, right] = [
      rows.at(rule.box.r1),
      rows.at(rule.box.r2),
      cols.at(rule.box.c1),
      cols.at(rule.box.c2),
    ];
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      return [rule];
    if (top > area.bottom || bottom < area.top || left > area.right || right < area.left)
      return [rule];
    const [middleTop, middleBottom] = [Math.max(top, area.top), Math.min(bottom, area.bottom)];
    const pieces = [
      top < area.top && { top, bottom: area.top - 1, left, right },
      bottom > area.bottom && { top: area.bottom + 1, bottom, left, right },
      left < area.left && { top: middleTop, bottom: middleBottom, left, right: area.left - 1 },
      right > area.right && { top: middleTop, bottom: middleBottom, left: area.right + 1, right },
    ].filter((piece) => piece !== false);
    return pieces.map((piece, index) => ({
      ...rule,
      id: index ? mint() : rule.id,
      box: {
        r1: rows.ids[piece.top - 1]!,
        r2: rows.ids[piece.bottom - 1]!,
        c1: cols.ids[piece.left - 1]!,
        c2: cols.ids[piece.right - 1]!,
      },
    }));
  });
}

/** The validation over a cell, the last listed winning as Excel keeps one per cell. */
export function validationAt(
  doc: SheetDoc,
  sheet: string,
  r: string,
  c: string,
): Validation | null {
  const data = doc.sheet[sheet];
  if (!data?.validations?.length) return null;
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [row, col] = [rows.at(r), cols.at(c)];
  if (row === undefined || col === undefined) return null;
  for (const each of data.validations.toReversed()) {
    const [top, bottom, left, right] = [
      rows.at(each.box.r1),
      rows.at(each.box.r2),
      cols.at(each.box.c1),
      cols.at(each.box.c2),
    ];
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      continue;
    if (row >= top && row <= bottom && col >= left && col <= right) return each;
  }
  return null;
}

/** A list rule's choices: its own, or the shown texts of its source cells, blanks left out. */
export function listChoices(doc: SheetDoc, values: SheetValues, rule: ValidationRule): string[] {
  if (rule.kind !== "list") return [];
  if (rule.values) return [...rule.values];
  const source = rule.source!;
  const data = doc.sheet[source.sh];
  if (!data) return [];
  const rows = positions(data.rows);
  const cols = positions(data.cols);
  const [top, bottom, left, right] = [
    rows.at(source.box.r1),
    rows.at(source.box.r2),
    cols.at(source.box.c1),
    cols.at(source.box.c2),
  ];
  if (top === undefined || bottom === undefined || left === undefined || right === undefined)
    return [];
  const choices: string[] = [];
  for (const r of rows.ids.slice(top - 1, bottom))
    for (const c of cols.ids.slice(left - 1, right)) {
      const shown = shownText(doc, values, source.sh, r, c);
      if (shown && !choices.includes(shown)) choices.push(shown);
    }
  return choices;
}

const passes = (value: number, test: ValidationTest, [a, b = a]: readonly number[]) => {
  const [low, high] = [Math.min(a!, b!), Math.max(a!, b!)];
  switch (test) {
    case "between":
      return value >= low && value <= high;
    case "notBetween":
      return value < low || value > high;
    case "equal":
      return value === a;
    case "notEqual":
      return value !== a;
    case "greater":
      return value > a!;
    case "less":
      return value < a!;
    case "greaterOrEqual":
      return value >= a!;
    case "lessOrEqual":
      return value <= a!;
  }
};

/**
 * Whether a value may stand in a cell under a validation: `shown` is how the
 * cell would show it, which a list compares without case, as Excel does.
 */
export function allowed(
  doc: SheetDoc,
  values: SheetValues,
  validation: Validation,
  value: Scalar,
  shown: string,
): boolean {
  if (value === null || value === "") return validation.allowBlank;
  const { rule } = validation;
  switch (rule.kind) {
    case "list":
      return listChoices(doc, values, rule).some(
        (choice) => choice.toLowerCase() === shown.toLowerCase(),
      );
    case "length":
      return passes(shown.length, rule.test, rule.values);
    case "whole":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        passes(value, rule.test, rule.values)
      );
    case "decimal":
    case "date":
      return typeof value === "number" && passes(value, rule.test, rule.values);
  }
}

/** The cells of a sheet whose current values break their validation, by `r|c`, for Circle Invalid Data. */
export function invalidCells(doc: SheetDoc, values: SheetValues, sheet: string): Set<string> {
  const invalid = new Set<string>();
  const data = doc.sheet[sheet];
  if (!data?.validations?.length) return invalid;
  for (const [r, row] of Object.entries(data.cells))
    for (const c of Object.keys(row)) {
      const validation = validationAt(doc, sheet, r, c);
      if (!validation) continue;
      const value = values.value(sheet, r, c);
      if (!allowed(doc, values, validation, value, shownText(doc, values, sheet, r, c)))
        invalid.add(`${r}|${c}`);
    }
  return invalid;
}
