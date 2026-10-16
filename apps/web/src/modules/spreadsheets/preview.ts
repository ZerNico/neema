import type { ConditionalRule } from "@chat/sheet/conditional";
import type { CellStyle } from "@chat/sheet/style";

/** A value a cell stores: a formula's is the result the file saved with it. */
export type PreviewValue = string | number | boolean | { readonly error: string };

export interface PreviewCell {
  /** 1-based, as Excel counts. */
  readonly row: number;
  readonly col: number;
  readonly value?: PreviewValue;
  /** The formula behind the value, as Excel shows it, with "=". */
  readonly formula?: string;
  /** Its style, by place in `styles`. */
  readonly style?: number;
}

/**
 * One sheet of a workbook as stored, for people to look at: values as the
 * file saved them (nothing is recalculated unless the file kept no results),
 * styles, sizes, merges, panes and drawings. Charts are fetched one image each.
 */
export interface SpreadsheetPreview {
  readonly sheets: ReadonlyArray<{
    readonly name: string;
    readonly hidden?: true;
    /** The tab's colour, as #RRGGBB. */
    readonly color?: string;
  }>;
  readonly sheet: string;
  /** How far the sheet's cells reach. */
  readonly rows: number;
  readonly cols: number;
  readonly cells: readonly PreviewCell[];
  /** Every style a cell names, once. */
  readonly styles: readonly CellStyle[];
  /** Column widths in characters, as Excel keeps them. */
  readonly widths: ReadonlyArray<readonly [col: number, characters: number]>;
  /** Row heights in points. */
  readonly heights: ReadonlyArray<readonly [row: number, points: number]>;
  readonly merges: readonly string[];
  /** The first cell below and right of the frozen panes, such as "B2". */
  readonly freeze?: string;
  readonly hiddenRows: readonly number[];
  readonly hiddenCols: readonly number[];
  readonly conditional: ReadonlyArray<{ readonly ref: string; readonly rule: ConditionalRule }>;
  readonly charts: ReadonlyArray<{
    /** Its number among the drawn charts, for `?chart=`. */
    readonly index: number;
    readonly row: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
    /** In pixels. */
    readonly width: number;
    readonly height: number;
  }>;
  /** Charts not drawn: newer kinds, or more than a preview draws. */
  readonly otherCharts: number;
  readonly images: ReadonlyArray<{
    readonly row: number;
    readonly col: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    /** A data URL. */
    readonly src: string;
    readonly alt?: string;
  }>;
  /** Cells past what a preview sends were left out. */
  readonly truncated: boolean;
}
