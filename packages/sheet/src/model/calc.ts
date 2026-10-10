import type { CellBox } from "../a1.ts";
import {
  calculate,
  type CalcLimits,
  type CalcReport,
  type CellStore,
  type StoredFormula,
} from "../engine/calculate.ts";
import { XError, type Scalar } from "../engine/evaluate.ts";
import { renderFormula } from "./formula.ts";
import { liveSheets, positions, type SheetDoc } from "./model.ts";

/**
 * What every replica of a live sheet calculates from, so a browser and the
 * server agree: the revision, an epoch that a recalculation bumps, the moment
 * (the revision's commit time in the sheet's time zone, as an Excel serial)
 * and a seed for chance.
 */
export interface CalcContext {
  readonly revision: number;
  readonly epoch: number;
  readonly now: number;
  readonly seed: number;
}

/** A live sheet's calculated values, by sheet, row and column ID. */
export interface SheetValues {
  readonly context: CalcContext;
  readonly report: CalcReport;
  /** A cell's value: what was typed, or a formula's or a spill's result. */
  value(sheet: string, row: string, col: string): Scalar;
  /** The cells a dynamic formula spills into, by ID, or null. */
  spill(sheet: string, row: string, col: string): { rows: string[]; cols: string[] } | null;
}

export const LIVE_CALC: CalcLimits = { errorsListed: 40, links: 2_000_000, spill: 200_000 };

/** FNV-1a over a string: a seed for one random call's stream. */
const hash = (text: string) => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};
/** Mulberry32: integer arithmetic only, so every runtime draws the same numbers. */
const stream = (seed: number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const key = (sheet: string, row: string, col: string) => `${sheet}\u0000${row}\u0000${col}`;

/** Calculates every formula of a live sheet document. Nothing is written to the document. */
export function calculateSheet(
  doc: SheetDoc,
  context: CalcContext,
  limits: CalcLimits = LIVE_CALC,
): SheetValues {
  const sheetIds = liveSheets(doc);
  const byName = new Map(sheetIds.map((id) => [doc.sheet[id]!.name.toLowerCase(), id]));
  const idOf = (name: string) => byName.get(name.toLowerCase());
  const rowsOf = (id: string) => positions(doc.sheet[id]!.rows);
  const colsOf = (id: string) => positions(doc.sheet[id]!.cols);
  /** A position on a sheet named in A1 terms, as IDs; null past the grid. */
  const ids = (name: string, row: number, column: number) => {
    const sheet = idOf(name);
    if (!sheet) return null;
    const r = rowsOf(sheet).ids[row - 1];
    const c = colsOf(sheet).ids[column - 1];
    return r && c ? { sheet, r, c } : null;
  };
  const results = new Map<string, Scalar>();
  const areas = new Map<string, CellBox>();
  const spilled = new Set<string>();
  const formulaIds = new Map<StoredFormula, { sheet: string; r: string; c: string }>();

  const store: CellStore = {
    sheets: sheetIds.map((id) => doc.sheet[id]!.name),
    *formulas() {
      formulaIds.clear();
      for (const id of sheetIds) {
        const sheet = doc.sheet[id]!;
        const rows = rowsOf(id);
        const cols = colsOf(id);
        for (const [r, row] of Object.entries(sheet.cells)) {
          const top = rows.at(r);
          if (top === undefined) continue;
          for (const [c, cell] of Object.entries(row)) {
            const left = cols.at(c);
            if (left === undefined || !cell.f) continue;
            // A formula that spilled in an earlier pass reports where, so its own values don't block it.
            const spilledTo = areas.get(key(id, r, c));
            const stored: StoredFormula = {
              sheet: sheet.name,
              row: top,
              column: left,
              text: renderFormula(cell.f, { doc, sheet: id }),
              form: cell.array || spilledTo ? "array" : "normal",
              dynamic: !cell.array && !!spilledTo,
              area: cell.array
                ? {
                    top,
                    left,
                    bottom: top + cell.array.rows - 1,
                    right: left + cell.array.cols - 1,
                  }
                : (spilledTo ?? null),
              // Every formula written live follows Excel 365: dynamic arrays, spilling.
              authored: true,
            };
            formulaIds.set(stored, { sheet: id, r, c });
            // Until calculated, a formula shows what it would if the engine could not read it.
            results.set(key(id, r, c), new XError("#NAME?"));
            yield stored;
          }
        }
      }
    },
    *names() {
      const first = sheetIds[0] ?? "";
      for (const name of Object.values(doc.names))
        yield { name: name.name, scope: null, text: renderFormula(name.f, { doc, sheet: first }) };
    },
    tables: () => new Map(),
    value: (name, row, column) => {
      const at = ids(name, row, column);
      if (!at) return null;
      const known = results.get(key(at.sheet, at.r, at.c));
      if (known !== undefined) return known;
      return doc.sheet[at.sheet]!.cells[at.r]?.[at.c]?.v ?? null;
    },
    isFormula: (name, row, column) => {
      const at = ids(name, row, column);
      return !!at && !!doc.sheet[at.sheet]!.cells[at.r]?.[at.c]?.f;
    },
    arrayArea: (name, row, column) => {
      const at = ids(name, row, column);
      return at ? (areas.get(key(at.sheet, at.r, at.c)) ?? null) : null;
    },
    // A live grid ends where its rows and columns do; a spill past them is #SPILL!, never cut short.
    bounds: (name) => {
      const sheet = idOf(name);
      return sheet
        ? { rows: rowsOf(sheet).ids.length, columns: colsOf(sheet).ids.length }
        : { rows: 0, columns: 0 };
    },
    extent: (name) => {
      const sheet = idOf(name);
      if (!sheet) return { rows: 0, columns: 0 };
      const rows = rowsOf(sheet);
      const cols = colsOf(sheet);
      let [bottom, right] = [0, 0];
      for (const [r, row] of Object.entries(doc.sheet[sheet]!.cells)) {
        const top = rows.at(r);
        if (top === undefined) continue;
        for (const [c, cell] of Object.entries(row)) {
          const left = cols.at(c);
          if (left === undefined || (cell.v === undefined && !cell.f)) continue;
          bottom = Math.max(bottom, top);
          right = Math.max(right, left);
        }
      }
      for (const spilledKey of spilled) {
        const [id, r, c] = spilledKey.split("\u0000") as [string, string, string];
        if (id !== sheet) continue;
        bottom = Math.max(bottom, rows.at(r) ?? 0);
        right = Math.max(right, cols.at(c) ?? 0);
      }
      return { rows: bottom, columns: right };
    },
    setResult: (formula, result, area) => {
      const at = formulaIds.get(formula)!;
      results.set(key(at.sheet, at.r, at.c), result);
      if (area) areas.set(key(at.sheet, at.r, at.c), area);
    },
    setValue: (name, row, column, value) => {
      const at = ids(name, row, column);
      if (!at) return;
      results.set(key(at.sheet, at.r, at.c), value);
      spilled.add(key(at.sheet, at.r, at.c));
    },
    // Only a spill's own values are cleared: what someone typed is never touched.
    clearValue: (name, row, column) => {
      const at = ids(name, row, column);
      if (!at) return;
      const spilledKey = key(at.sheet, at.r, at.c);
      if (!spilled.has(spilledKey)) return;
      spilled.delete(spilledKey);
      results.delete(spilledKey);
    },
    setUncalculated: () => {
      // The formula keeps the #NAME? it was given before calculating.
    },
    setCircular: (formula) => {
      const at = formulaIds.get(formula)!;
      results.set(key(at.sheet, at.r, at.c), 0);
    },
    volatile: (formula) => {
      const at = formulaIds.get(formula)!;
      return {
        now: context.now,
        random: (call) => stream(hash(`${context.seed}|${at.sheet}|${at.r}|${at.c}|${call}`)),
      };
    },
  };

  const report = calculate(store, limits);
  return {
    context,
    report,
    value: (sheet, row, col) => {
      const known = results.get(key(sheet, row, col));
      if (known !== undefined) return known;
      return doc.sheet[sheet]?.cells[row]?.[col]?.v ?? null;
    },
    spill: (sheet, row, col) => {
      const box = areas.get(key(sheet, row, col));
      if (!box) return null;
      const rows = rowsOf(sheet).ids.slice(box.top - 1, box.bottom);
      const cols = colsOf(sheet).ids.slice(box.left - 1, box.right);
      return { rows, cols };
    },
  };
}
