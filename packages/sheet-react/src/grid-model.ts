import type { ConditionalRule } from "@chat/sheet/conditional";

/** A row's height in points or a column's width in characters, as Excel keeps them. */
export interface AxisProps {
  readonly size?: number;
  readonly hidden?: true;
}

/** A range by its corner rows and columns, by key. */
export interface Box {
  readonly r1: string;
  readonly r2: string;
  readonly c1: string;
  readonly c2: string;
}

/** A cell the grid draws something in; its value comes from the grid's `value`. */
export interface Cell {
  /** A style key, as `styleKey` writes one. */
  readonly s?: string;
}

/** A conditional format over a range, the first taking priority. */
export interface ConditionalFormat {
  readonly box: Box;
  readonly rule: ConditionalRule;
}

/**
 * One sheet as the grid draws it: rows and columns by key, in order, and the
 * cells, sizes, merges and panes on them.
 */
export interface GridSheet {
  readonly name: string;
  readonly rows: readonly string[];
  readonly cols: readonly string[];
  /** Row key, then column key; absent rows and cells are empty. */
  readonly cells: Readonly<Record<string, Readonly<Record<string, Cell>>>>;
  readonly rowProps: Readonly<Record<string, AxisProps>>;
  readonly colProps: Readonly<Record<string, AxisProps>>;
  readonly merges: readonly Box[];
  /** Rows and columns frozen up to and including these keys. */
  readonly freeze: { readonly row: string | null; readonly col: string | null };
  readonly conditional?: readonly ConditionalFormat[];
}
