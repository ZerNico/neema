import type { ValidationTest } from "@chat/sheet/model/validation";
import {
  addDataValidation,
  makeDataValidation,
  type DataValidation,
  type DataValidationOperator,
  type Worksheet,
} from "@office-kit/xlsx/worksheet";

/**
 * Data validation as Excel files keep it, by A1 range on its sheet. A list
 * is its values, or the cells it reads as `Sheet!A1:A9` text; a test is on
 * whole numbers, decimals, dates (serials) or text length.
 */
export interface FileValidation {
  readonly ref: string;
  readonly rule:
    | { readonly kind: "list"; readonly values: readonly string[] }
    | { readonly kind: "list"; readonly source: string }
    | {
        readonly kind: "whole" | "decimal" | "date" | "length";
        readonly test: ValidationTest;
        readonly values: readonly [number] | readonly [number, number];
      };
  readonly onError: "stop" | "warning" | "information";
  readonly message?: string;
  readonly allowBlank: boolean;
}

const OPERATORS: Record<ValidationTest, DataValidationOperator> = {
  between: "between",
  notBetween: "notBetween",
  equal: "equal",
  notEqual: "notEqual",
  greater: "greaterThan",
  less: "lessThan",
  greaterOrEqual: "greaterThanOrEqual",
  lessOrEqual: "lessThanOrEqual",
};

/** Writes a sheet's validations, each as Excel's own kind. */
export function writeValidations(sheet: Worksheet, validations: readonly FileValidation[]) {
  for (const { ref, rule, onError, message, allowBlank } of validations) {
    const common = {
      sqref: ref,
      allowBlank,
      showErrorMessage: true,
      errorStyle: onError,
      ...(message ? { error: message } : {}),
    };
    addDataValidation(
      sheet,
      rule.kind === "list"
        ? makeDataValidation({
            ...common,
            type: "list",
            // A written list is one quoted text of commas; a read one, its range.
            formula1:
              "source" in rule ? rule.source : `"${rule.values.join(",").replace(/"/g, '""')}"`,
          })
        : makeDataValidation({
            ...common,
            type: rule.kind === "length" ? "textLength" : rule.kind,
            operator: OPERATORS[rule.test],
            formula1: String(rule.values[0]),
            ...(rule.values[1] === undefined ? {} : { formula2: String(rule.values[1]) }),
          }),
    );
  }
}

/** A validation Excel wrote, as a live sheet keeps one; null for kinds it does not (time, custom). */
export function readValidation(validation: DataValidation, ref: string): FileValidation | null {
  const shared = {
    ref,
    onError: validation.errorStyle ?? "stop",
    allowBlank: validation.allowBlank ?? false,
    ...(validation.error ? { message: validation.error.slice(0, 255) } : {}),
  };
  const formula = (validation.formula1 ?? "").replace(/^=/, "");
  if (validation.type === "list") {
    const written = /^"(.*)"$/s.exec(formula)?.[1];
    if (written !== undefined)
      return {
        ...shared,
        rule: {
          kind: "list",
          values: written
            .replace(/""/g, '"')
            .split(",")
            .map((each) => each.trim())
            .filter(Boolean),
        },
      };
    return formula ? { ...shared, rule: { kind: "list", source: formula } } : null;
  }
  if (
    validation.type !== "whole" &&
    validation.type !== "decimal" &&
    validation.type !== "date" &&
    validation.type !== "textLength"
  )
    return null;
  const test = (Object.entries(OPERATORS).find(
    ([, name]) => name === (validation.operator ?? "between"),
  )?.[0] ?? "between") as ValidationTest;
  const [a, b] = [Number(formula), Number((validation.formula2 ?? "").replace(/^=/, ""))];
  if (!Number.isFinite(a) || formula === "") return null;
  const two = test === "between" || test === "notBetween";
  if (two && !Number.isFinite(b)) return null;
  return {
    ...shared,
    rule: {
      kind: validation.type === "textLength" ? "length" : validation.type,
      test,
      values: two ? [a, b] : [a],
    },
  };
}
