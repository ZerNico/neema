import { cellStyle } from "./style.ts";
import { placeBox } from "./box.ts";
import { XError } from "../engine/values.ts";
import { sheetLocale } from "../locales.ts";
import { formatValue, generalText } from "../number-format.ts";
import type { SheetValues } from "./calc.ts";
import type { Box, SheetDoc } from "./model.ts";
import { isId, isRecord } from "./check.ts";

/**
 * A sheet's AutoFilter, as Excel keeps one: a range whose first row holds the
 * buttons, and per column what its rows must show to stay in view. Rows that
 * fail are hidden when drawn, never stored as hidden, so a changed value
 * shows or hides its row at once on every replica.
 */
export interface SheetFilter {
  readonly box: Box;
  /** By column ID; a column without a rule keeps every row. */
  readonly rules: Readonly<Record<string, FilterRule>>;
}
export const FILTER_CONDITIONS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "beginsWith",
  "endsWith",
  "greater",
  "greaterOrEqual",
  "less",
  "lessOrEqual",
  "empty",
  "notEmpty",
] as const;
export type FilterCondition = (typeof FILTER_CONDITIONS)[number];
export interface FilterRule {
  /** The shown texts a row may have here, "" for an empty cell; absent, any. */
  readonly values?: readonly string[];
  /** A test the value must pass, as Excel's custom filter. */
  readonly condition?: { readonly op: FilterCondition; readonly value?: string | number };
}

export const FILTER_LIMITS = { values: 10_000, text: 255 } as const;

/** Whether a filter, as an operation carries one, is well formed. */
export function isSheetFilter(value: unknown): value is SheetFilter {
  if (!isRecord(value) || !isRecord(value.box) || !isRecord(value.rules)) return false;
  const box = value.box;
  if (![box.r1, box.r2, box.c1, box.c2].every(isId)) return false;
  return Object.entries(value.rules).every(
    ([column, rule]) =>
      isId(column) &&
      isRecord(rule) &&
      (rule.values === undefined ||
        (Array.isArray(rule.values) &&
          rule.values.length <= FILTER_LIMITS.values &&
          rule.values.every(
            (each) => typeof each === "string" && each.length <= FILTER_LIMITS.text,
          ))) &&
      (rule.condition === undefined ||
        (isRecord(rule.condition) &&
          FILTER_CONDITIONS.includes(rule.condition.op as FilterCondition) &&
          (rule.condition.value === undefined ||
            (typeof rule.condition.value === "string" &&
              rule.condition.value.length <= FILTER_LIMITS.text) ||
            (typeof rule.condition.value === "number" && Number.isFinite(rule.condition.value))))),
  );
}

/** A filter's rows and columns by position, its header row first; null once its cells are gone. */
export function filterSpan(doc: SheetDoc, sheet: string, filter: SheetFilter) {
  const placed = placeBox(doc.sheet[sheet], filter.box);
  if (!placed) return null;
  return { header: placed.rows[0]!, body: placed.rows.slice(1), columns: placed.cols };
}

/** What a cell shows, as a filter's value list names it. */
export function shownText(doc: SheetDoc, values: SheetValues, sheet: string, r: string, c: string) {
  const value = values.value(sheet, r, c);
  if (value === null) return "";
  if (value instanceof XError) return value.code;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  const locale = sheetLocale(doc.settings.locale);
  const key = doc.sheet[sheet]?.cells[r]?.[c]?.s;
  const format = cellStyle(key).numberFormat;
  if (typeof format === "string") {
    const formatted = formatValue(value, format, locale);
    if (formatted) return formatted.text;
  }
  return typeof value === "number" ? generalText(value, locale) : value;
}

/** Whether a value passes a condition; text compares without case, numbers as numbers. */
function passes(
  value: unknown,
  shown: string,
  condition: NonNullable<FilterRule["condition"]>,
): boolean {
  const { op } = condition;
  if (op === "empty") return shown === "";
  if (op === "notEmpty") return shown !== "";
  const wanted = condition.value ?? "";
  const number = typeof wanted === "number" ? wanted : Number(wanted);
  if (op === "greater" || op === "greaterOrEqual" || op === "less" || op === "lessOrEqual") {
    if (typeof value !== "number" || !Number.isFinite(number) || wanted === "") return false;
    return op === "greater"
      ? value > number
      : op === "greaterOrEqual"
        ? value >= number
        : op === "less"
          ? value < number
          : value <= number;
  }
  const [text, target] = [shown.toLowerCase(), String(wanted).toLowerCase()];
  const equal =
    typeof value === "number" && wanted !== "" && Number.isFinite(number)
      ? value === number || text === target
      : text === target;
  switch (op) {
    case "equals":
      return equal;
    case "notEquals":
      return !equal;
    case "contains":
      return text.includes(target);
    case "notContains":
      return !text.includes(target);
    case "beginsWith":
      return text.startsWith(target);
    case "endsWith":
      return text.endsWith(target);
  }
}

/** The rows a sheet's filter hides now, by ID; none without a filter. */
export function filteredRows(doc: SheetDoc, values: SheetValues, sheet: string): Set<string> {
  const hidden = new Set<string>();
  const filter = doc.sheet[sheet]?.filter;
  if (!filter) return hidden;
  const span = filterSpan(doc, sheet, filter);
  if (!span) return hidden;
  const rules = Object.entries(filter.rules).filter(([column]) => span.columns.includes(column));
  if (!rules.length) return hidden;
  const kept = rules.map(([column, rule]) => ({
    column,
    rule,
    values: rule.values ? new Set(rule.values) : null,
  }));
  for (const r of span.body)
    for (const { column, rule, values: allowed } of kept) {
      const shown = shownText(doc, values, sheet, r, column);
      if (
        (allowed && !allowed.has(shown)) ||
        (rule.condition && !passes(values.value(sheet, r, column), shown, rule.condition))
      ) {
        hidden.add(r);
        break;
      }
    }
  return hidden;
}
