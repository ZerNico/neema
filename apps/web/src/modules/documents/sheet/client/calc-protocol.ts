import { XError, type Scalar } from "@chat/sheet/engine/values";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";

export interface CalcRequest {
  readonly generation: number;
  readonly doc: SheetDoc;
  readonly context: CalcContext;
}
/** An error crosses to the page as its code; a class would not survive the copy. */
export type WireScalar = number | string | boolean | null | { readonly e: string };
export interface CalcResult {
  readonly generation: number;
  /** Every formula's result and every spilled value, by sheet, row and column ID. */
  readonly results: ReadonlyArray<readonly [string, WireScalar]>;
  readonly spills: ReadonlyArray<readonly [string, readonly string[], readonly string[]]>;
}

export const cellKey = (sheet: string, row: string, col: string) =>
  `${sheet}\u0000${row}\u0000${col}`;
export const toWire = (value: Scalar): WireScalar =>
  value instanceof XError ? { e: value.code } : value;
export const fromWire = (value: WireScalar): Scalar =>
  typeof value === "object" && value !== null ? new XError(value.e) : value;

/** Calculates a document and lists what differs from what it holds: formulas' results and spills. */
export function calculateForWire(request: CalcRequest): CalcResult {
  const values = calculateSheet(request.doc, request.context);
  const results: Array<readonly [string, WireScalar]> = [];
  const spills: Array<readonly [string, readonly string[], readonly string[]]> = [];
  for (const [sheet, data] of Object.entries(request.doc.sheet))
    for (const [r, row] of Object.entries(data.cells))
      for (const [c, cell] of Object.entries(row)) {
        if (!cell.f) continue;
        results.push([cellKey(sheet, r, c), toWire(values.value(sheet, r, c))]);
        const spill = values.spill(sheet, r, c);
        if (!spill) continue;
        spills.push([cellKey(sheet, r, c), spill.rows, spill.cols]);
        for (const sr of spill.rows)
          for (const sc of spill.cols)
            if (sr !== r || sc !== c)
              results.push([cellKey(sheet, sr, sc), toWire(values.value(sheet, sr, sc))]);
      }
  return { generation: request.generation, results, spills };
}
