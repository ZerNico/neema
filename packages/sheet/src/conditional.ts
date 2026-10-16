/**
 * Conditional formats, as Excel's Home tab makes them: rules over ranges that
 * colour cells by their values. The workbook reader resolves a file's rules
 * to these, and the grid works out what each cell shows when it draws.
 */

/** What a matching cell takes; colours are #RRGGBB. */
export interface ConditionalStyle {
  readonly fill?: string;
  readonly fontColor?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
}
export const COMPARISONS = [
  "greater",
  "greaterOrEqual",
  "less",
  "lessOrEqual",
  "equal",
  "notEqual",
  "between",
  "notBetween",
] as const;
export const TEXT_TESTS = ["contains", "notContains", "beginsWith", "endsWith"] as const;
export type ConditionalRule =
  | {
      readonly kind: "compare";
      readonly op: (typeof COMPARISONS)[number];
      readonly values: readonly [number | string] | readonly [number | string, number | string];
      readonly style: ConditionalStyle;
    }
  | {
      readonly kind: "text";
      readonly op: (typeof TEXT_TESTS)[number];
      readonly text: string;
      readonly style: ConditionalStyle;
    }
  | {
      readonly kind: "top";
      readonly count: number;
      readonly percent?: boolean;
      readonly bottom?: boolean;
      readonly style: ConditionalStyle;
    }
  | { readonly kind: "average"; readonly below?: boolean; readonly style: ConditionalStyle }
  | { readonly kind: "duplicate"; readonly unique?: boolean; readonly style: ConditionalStyle }
  | { readonly kind: "blank"; readonly not?: boolean; readonly style: ConditionalStyle }
  /**
   * Colours at each stop, mixed between them: by default the smallest number,
   * the 50th percentile when there are three, and the largest.
   */
  | {
      readonly kind: "scale";
      readonly colors: readonly [string, string] | readonly [string, string, string];
      readonly stops?: readonly Threshold[];
    }
  /** A bar across each cell, as long as its number is between the stops, by default the range's smallest and largest. */
  | {
      readonly kind: "bar";
      readonly color: string;
      readonly stops?: readonly [Threshold, Threshold];
    };

/** Where a scale or bar stop sits, as Excel's `cfvo` names it; percents are 0 to 100. */
export type Threshold =
  | { readonly type: "min" | "max" }
  | { readonly type: "number" | "percent" | "percentile"; readonly value: number };
