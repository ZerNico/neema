import type { CellBox } from "../a1.ts";
import {
  calculate,
  type CalcLimits,
  type CalcReport,
  type CellStore,
  type ChangedBox,
  type StoredFormula,
} from "../engine/calculate.ts";
import { XError, type Scalar } from "../engine/evaluate.ts";
import { renderFormula } from "./formula.ts";
import { liveSheets, positions, type Cell, type SheetDoc } from "./model.ts";

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
  /**
   * Whether any formula read the moment or drew a random number. Without, the
   * values follow from the document alone, whatever the context.
   */
  readonly volatile: boolean;
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

/** What a calculation leaves for the next to start from: what it read, and what it wrote. */
interface CalcState {
  readonly context: CalcContext;
  readonly volatile: boolean;
  readonly volatileCells: ReadonlySet<string>;
  /** Sheets, names and every sheet's rows and columns, as JSON: what positions follow from. */
  readonly structure: string;
  /** Each row's cells as JSON, by sheet and row ID. */
  readonly rows: ReadonlyMap<string, string>;
  readonly results: ReadonlyMap<string, Scalar>;
  readonly areas: ReadonlyMap<string, CellBox>;
  readonly spilled: ReadonlySet<string>;
}
const states = new WeakMap<SheetValues, CalcState>();

/** What of a cell a calculation reads: not its style. */
const content = (cell: Cell | undefined) => JSON.stringify([cell?.v, cell?.f, cell?.array]);

/**
 * Calculates every formula of a live sheet document. Nothing is written to the document.
 * Given the values calculated before, as `follows.previous`, it calculates only what the
 * difference reaches: a change to cell contents, in the same rows, columns, sheets and names,
 * and no new moment for a sheet reading it. Anything else is calculated whole. Passing
 * `follows` at all keeps what the next calculation needs to follow this one.
 */
export function calculateSheet(
  doc: SheetDoc,
  context: CalcContext,
  limits: CalcLimits = LIVE_CALC,
  follows?: { readonly previous: SheetValues | null },
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
  const tracked = follows !== undefined;
  const structure = tracked
    ? JSON.stringify([
        doc.sheets,
        doc.names,
        sheetIds.map((id) => [id, doc.sheet[id]!.name, doc.sheet[id]!.rows, doc.sheet[id]!.cols]),
      ])
    : "";
  const rowJson = new Map<string, string>();
  if (tracked)
    for (const id of sheetIds)
      for (const [r, row] of Object.entries(doc.sheet[id]!.cells))
        rowJson.set(`${id}\u0000${r}`, JSON.stringify(row));
  const before = follows?.previous ? states.get(follows.previous) : undefined;
  const follow =
    before &&
    before.structure === structure &&
    !(
      before.volatile &&
      (before.context.now !== context.now || before.context.seed !== context.seed)
    )
      ? before
      : undefined;
  const volatileCells = new Set(follow?.volatileCells);
  const results = new Map<string, Scalar>(follow?.results);
  const areas = new Map<string, CellBox>(follow?.areas);
  const spilled = new Set<string>(follow?.spilled);
  /** Forgets what a formula's cell spilled into, and the values it wrote there. */
  const dropArea = (id: string, r: string, c: string) => {
    const at = key(id, r, c);
    const area = areas.get(at);
    if (!area) return null;
    areas.delete(at);
    for (const sr of rowsOf(id).ids.slice(area.top - 1, area.bottom))
      for (const sc of colsOf(id).ids.slice(area.left - 1, area.right)) {
        const filled = key(id, sr, sc);
        if (spilled.delete(filled)) results.delete(filled);
      }
    return area;
  };
  // The cells whose content changed, and what they had spilled into, which is gone with them.
  const changed: ChangedBox[] | null = follow ? [] : null;
  if (follow && changed)
    for (const rowKey of new Set([...follow.rows.keys(), ...rowJson.keys()])) {
      if (follow.rows.get(rowKey) === rowJson.get(rowKey)) continue;
      const [id, r] = rowKey.split("\u0000") as [string, string];
      const sheet = doc.sheet[id]!;
      const was = JSON.parse(follow.rows.get(rowKey) ?? "{}") as Record<string, Cell>;
      const now = sheet.cells[r] ?? {};
      for (const c of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (content(was[c]) === content(now[c])) continue;
        const [top, left] = [rowsOf(id).at(r), colsOf(id).at(c)];
        if (top === undefined || left === undefined) continue;
        results.delete(key(id, r, c));
        volatileCells.delete(key(id, r, c));
        changed.push({ sheet: sheet.name, box: { top, left, bottom: top, right: left } });
        const area = dropArea(id, r, c);
        if (area) changed.push({ sheet: sheet.name, box: area });
      }
    }
  // A cell changed inside another formula's spill takes that spill apart too: what was typed
  // there blocks it, which only a formula spilling afresh tells from its own values.
  if (changed)
    for (const [owner, area] of areas) {
      const [id, r, c] = owner.split("\u0000") as [string, string, string];
      const name = doc.sheet[id]?.name;
      const hit = changed.some(
        (each) =>
          each.sheet === name &&
          each.box.top <= area.bottom &&
          each.box.bottom >= area.top &&
          each.box.left <= area.right &&
          each.box.right >= area.left,
      );
      if (name && hit && dropArea(id, r, c)) changed.push({ sheet: name, box: area });
    }
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
      // Shown as 0, it fills nothing.
      dropArea(at.sheet, at.r, at.c);
      volatileCells.delete(key(at.sheet, at.r, at.c));
      results.set(key(at.sheet, at.r, at.c), 0);
    },
    previous: (formula) => {
      const at = formulaIds.get(formula)!;
      return follow?.results.get(key(at.sheet, at.r, at.c));
    },
    volatile: (formula) => {
      const at = formulaIds.get(formula)!;
      const cell = key(at.sheet, at.r, at.c);
      // Evaluated formulas replace their metadata. Reused results keep theirs.
      volatileCells.delete(cell);
      return {
        get now() {
          volatileCells.add(cell);
          return context.now;
        },
        random: (call) => {
          volatileCells.add(cell);
          return stream(hash(`${context.seed}|${at.sheet}|${at.r}|${at.c}|${call}`));
        },
      };
    },
  };

  const report = calculate(store, limits, changed);
  const volatile = volatileCells.size > 0;
  const values: SheetValues = {
    context,
    report,
    volatile,
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
  if (tracked)
    states.set(values, {
      context,
      volatile,
      volatileCells,
      structure,
      rows: rowJson,
      results,
      areas,
      spilled,
    });
  return values;
}
