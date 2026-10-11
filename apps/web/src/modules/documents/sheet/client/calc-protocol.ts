import { XError, type Scalar } from "@chat/sheet/engine/values";
import { calculateSheet, type CalcContext, type SheetValues } from "@chat/sheet/model/calc";
import type { SheetDoc } from "@chat/sheet/model";

export interface CalcRequest {
  readonly generation: number;
  readonly doc: SheetDoc;
  readonly context: CalcContext;
}
/**
 * A request as posted to the worker: the document as its JSON, which the page
 * writes in a quarter of the time a structured copy takes, the worker reading
 * it on its own thread. A document is JSON already; the server stores it so.
 */
export interface CalcPost {
  readonly generation: number;
  readonly doc: string;
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

const EMPTY_REPORT = { formulas: 0, errors: [], errorCount: 0, unsupported: [] };

/**
 * Values as the page reads them while a calculation may lag the document: a
 * typed value at once, a formula's last result until the new one. A spilled
 * value lasts only while its formula is there, so clearing it empties the
 * spill at once rather than when the worker answers.
 */
export function valuesOf(
  doc: SheetDoc,
  context: CalcContext,
  result: CalcResult | null,
): SheetValues {
  const results = new Map<string, Scalar>(
    (result?.results ?? []).map(([key, value]) => [key, fromWire(value)]),
  );
  const spills = new Map(
    (result?.spills ?? []).map(([key, rows, cols]) => [key, { rows: [...rows], cols: [...cols] }]),
  );
  const spilledFrom = new Map<string, readonly [string, string, string]>();
  for (const [key, area] of spills) {
    const [sheet, r, c] = key.split("\u0000") as [string, string, string];
    for (const row of area.rows)
      for (const col of area.cols) spilledFrom.set(cellKey(sheet, row, col), [sheet, r, c]);
  }
  return {
    context,
    report: EMPTY_REPORT,
    value: (sheet, r, c) => {
      const cell = doc.sheet[sheet]?.cells[r]?.[c];
      const key = cellKey(sheet, r, c);
      if (cell?.f) return results.get(key) ?? null;
      if (cell && cell.v !== undefined) return cell.v;
      const from = spilledFrom.get(key);
      return from && doc.sheet[from[0]]?.cells[from[1]]?.[from[2]]?.f
        ? (results.get(key) ?? null)
        : null;
    },
    spill: (sheet, r, c) =>
      doc.sheet[sheet]?.cells[r]?.[c]?.f ? (spills.get(cellKey(sheet, r, c)) ?? null) : null,
  };
}
