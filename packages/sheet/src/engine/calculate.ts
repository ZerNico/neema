import { boxRef, columnLetters, MAX_COLUMN, MAX_ROW, type CellBox } from "../a1.ts";
import { evaluateFormula, Grid, XError, type Mode, type Scalar, type Scope } from "./evaluate.ts";
import {
  calls,
  parseFormula,
  references,
  Unsupported,
  type Node,
  type ParseContext,
  type TableShape,
} from "./parse.ts";

/**
 * Recalculation over any cell storage: the Excel file tools' workbook, and a
 * live sheet. The storage answers reads and takes results; the order,
 * spills, legacy arrays and cycles are decided here, once for both.
 */

/** A formula cell as storage holds it. */
export interface StoredFormula {
  readonly sheet: string;
  readonly row: number;
  readonly column: number;
  /** The formula without its `=`; file prefixes such as `_xlfn.` are read as they are. */
  readonly text: string;
  /** A plain formula, or an array formula (a dynamic one, or a legacy one entered over a range). */
  readonly form: "normal" | "array";
  readonly dynamic: boolean;
  /** An array formula's range as last stored; null for a plain one. */
  readonly area: CellBox | null;
  /** Written in this edit, so it follows Excel 365 even without a dynamic mark. */
  readonly authored: boolean;
}

export interface CellStore {
  /** Sheet names in workbook order. */
  readonly sheets: readonly string[];
  formulas(): Iterable<StoredFormula>;
  /** Defined names; `scope` is a sheet's index for a sheet-level name. */
  names(): Iterable<{
    readonly name: string;
    readonly scope: number | null;
    readonly text: string;
  }>;
  tables(): ReadonlyMap<string, TableShape>;
  /** A cell's value, a formula's last result included. */
  value(sheet: string, row: number, column: number): Scalar;
  isFormula(sheet: string, row: number, column: number): boolean;
  /** The range an array formula at the cell currently fills. */
  arrayArea(sheet: string, row: number, column: number): CellBox | null;
  /** The last row and column holding anything. */
  extent(sheet: string): { readonly rows: number; readonly columns: number };
  /** How many rows and columns the sheet has, past which nothing spills: Excel's grid in a file. */
  bounds(sheet: string): { readonly rows: number; readonly columns: number };
  /** Stores a result; with `area`, the formula becomes a dynamic array filling it. */
  setResult(formula: StoredFormula, result: Scalar, area?: CellBox): void;
  /** Writes a plain value a spill or a legacy array produced. */
  setValue(sheet: string, row: number, column: number, value: Scalar): void;
  /** Empties a cell holding a plain value; a formula is left alone. */
  clearValue(sheet: string, row: number, column: number): void;
  /** Drops a formula's result, for its reader to calculate; `dynamic` saves it as a dynamic array. */
  setUncalculated(formula: StoredFormula, dynamic: boolean): void;
  /** Stores 0 for a formula on or behind a cycle, as Excel shows it. */
  setCircular(formula: StoredFormula): void;
  /** Time and chance for a formula's NOW, TODAY and RAND; without it they are not calculated. */
  volatile?(formula: StoredFormula): Scope["volatile"];
}

export interface CalcLimits {
  /** Formula errors listed by cell; the count covers all. */
  readonly errorsListed: number;
  /** Dependency links one calculation may build. */
  readonly links: number;
  /** Cells one formula may spill into. */
  readonly spill: number;
}

export interface FormulaIssue {
  readonly cell: string;
  readonly error: string;
}
export interface CalcReport {
  readonly formulas: number;
  /** Cells whose formula evaluates to an error, bounded; `errorCount` is the full count. */
  readonly errors: readonly FormulaIssue[];
  readonly errorCount: number;
  /** What the engine doesn't evaluate; those cells keep the value they carried. */
  readonly unsupported: readonly string[];
}

/** Formulas computed out of order, one inside another, for references known only at run time. */
const MAX_NESTED = 100;
/** Spills that change shape move what other formulas read; each pass settles one more round. */
const MAX_PASSES = 3;

/** Functions whose result is an array: Excel 365 always saves them as dynamic formulas. */
export const ARRAY_FUNCTIONS = new Set([
  "FILTER",
  "SORT",
  "SORTBY",
  "UNIQUE",
  "SEQUENCE",
  "RANDARRAY",
  "TAKE",
  "DROP",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "VSTACK",
  "HSTACK",
  "TOCOL",
  "TOROW",
  "WRAPROWS",
  "WRAPCOLS",
  "EXPAND",
  "TEXTSPLIT",
  "TRANSPOSE",
  "MMULT",
  "MINVERSE",
  "MUNIT",
  "FREQUENCY",
  "LINEST",
  "LOGEST",
  "TREND",
  "GROWTH",
  "ANCHORARRAY",
  "MAP",
  "BYROW",
  "BYCOL",
  "MAKEARRAY",
  "SCAN",
  "GROUPBY",
  "PIVOTBY",
]);
/** The same functions as they appear in text, for formulas the engine can't parse. */
const ARRAY_CALL = new RegExp(
  `(?<![\\w.])(?:_xlfn\\.(?:_xlws\\.)?)?(?:${[...ARRAY_FUNCTIONS].join("|")})\\s*\\(`,
  "i",
);

/**
 * - `legacy`: a plain formula from storage, read by implicit intersection
 * - `dynamic`: Excel 365's, spilling; a plain one written in this edit becomes one if it needs to
 * - `cse`: a legacy array formula, filling the range it was entered over
 */
type Kind = "legacy" | "dynamic" | "cse";
interface Formula {
  readonly stored: StoredFormula;
  readonly node: Node;
  readonly kind: Kind;
  /** The cells an array formula filled last time, its own included. */
  readonly area: CellBox | null;
}

// Formulas as parsed, by their text. Without tables a formula's text alone decides its tree,
// which is never changed once built, so a calculation after an edit parses only what changed.
const parsedTexts = new Map<string, Node | Unsupported>();
const PARSED_KEPT = 50_000;
function parsedText(text: string): Node {
  let parsed = parsedTexts.get(text);
  if (!parsed) {
    try {
      parsed = parseFormula(text, {});
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      parsed = error;
    }
    // One process calculates every document: the cache is bounded, not kept for its lifetime.
    if (parsedTexts.size >= PARSED_KEPT) parsedTexts.clear();
    parsedTexts.set(text, parsed);
  }
  if (parsed instanceof Unsupported) throw parsed;
  return parsed;
}

const cellKey = (sheet: string, row: number, column: number) =>
  `${sheet.toLowerCase()}\u0000${row}\u0000${column}`;
const inside = (box: CellBox | null, row: number, column: number) =>
  !!box && row >= box.top && row <= box.bottom && column >= box.left && column <= box.right;
const address = (sheet: string, row: number, column: number) =>
  `${sheet}!${columnLetters(column)}${row}`;
const own = (formula: StoredFormula) => ({
  top: formula.row,
  left: formula.column,
  bottom: formula.row,
  right: formula.column,
});

/**
 * Evaluates every formula in dependency order and stores each result, so
 * every reader sees results. Dynamic formulas spill into the cells beside
 * them, as Excel 365 does. The order is built without recursion, so a long
 * chain of cells each reading the one above can't overflow the stack.
 */
export function calculate(store: CellStore, limits: CalcLimits): CalcReport {
  let report = pass(store, limits);
  for (let passes = 1; report.reshaped && passes < MAX_PASSES; passes++)
    report = pass(store, limits);
  return report.result;
}

function pass(store: CellStore, limits: CalcLimits) {
  const order = store.sheets;
  const sheetIndex = new Map(order.map((sheet, index) => [sheet.toLowerCase(), index]));
  const sheetNamed = (name: string) => {
    const index = sheetIndex.get(name.toLowerCase());
    return index === undefined ? undefined : order[index];
  };
  const tables = store.tables();
  const contextFor = (sheet: string, row?: number, column?: number): ParseContext => ({
    table: (name) => {
      if (name) return tables.get(name.toLowerCase()) ?? null;
      if (row === undefined || column === undefined) return null;
      for (const table of tables.values())
        if (table.sheet === sheet && inside(table.box, row, column)) return table;
      return null;
    },
    ...(row === undefined ? {} : { row }),
  });

  const unsupported = new Set<string>();
  const formulas: Formula[] = [];
  const unread: StoredFormula[] = [];
  for (const stored of store.formulas()) {
    const kind: Kind =
      stored.form === "normal"
        ? stored.authored
          ? "dynamic"
          : "legacy"
        : stored.dynamic
          ? "dynamic"
          : "cse";
    try {
      formulas.push({
        stored,
        node: tables.size
          ? parseFormula(stored.text, contextFor(stored.sheet, stored.row, stored.column))
          : parsedText(stored.text),
        kind,
        area: stored.form === "array" ? (stored.area ?? own(stored)) : null,
      });
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      unsupported.add(error.what);
      if (stored.authored) unread.push(stored);
    }
  }
  const empty = {
    formulas: formulas.length,
    errors: [],
    errorCount: 0,
    unsupported: [...unsupported],
  };
  if (formulas.length === 0) return { result: empty, reshaped: false };

  // Names resolve per sheet first, then for the workbook.
  const names = new Map<string, Node | null>();
  for (const name of store.names()) {
    let node: Node | null = null;
    try {
      node = parseFormula(name.text, {
        table: (table) => (table ? (tables.get(table.toLowerCase()) ?? null) : null),
      });
    } catch {
      // A name the engine can't read leaves its users at #NAME?, which is reported.
    }
    names.set(`${name.scope ?? "*"}\u0000${name.name.toLowerCase()}`, node);
  }
  const nameFor = (sheet: string, name: string) => {
    const scoped = `${sheetIndex.get(sheet.toLowerCase())}\u0000${name.toLowerCase()}`;
    return names.has(scoped)
      ? names.get(scoped)!
      : (names.get(`*\u0000${name.toLowerCase()}`) ?? null);
  };
  const between = (first: string, last: string) => {
    const a = sheetIndex.get(first.toLowerCase());
    const b = sheetIndex.get(last.toLowerCase());
    if (a === undefined || b === undefined) return null;
    const [from, to] = [a, b].toSorted((x, y) => x - y);
    return order.slice(from, to! + 1);
  };

  // Formula cells by sheet and column, sorted by row, to find those inside a range.
  const ids = new Map<string, number>();
  const byColumn = new Map<string, Map<number, number[]>>();
  // An array formula owns the cells it filled: reading one waits for it.
  const areas: Array<{ sheet: string; box: CellBox; id: number }> = [];
  // The same areas by sheet and column, so reading a cell asks only those that could own it.
  const areasByColumn = new Map<string, Map<number, number[]>>();
  formulas.forEach((formula, id) => {
    const { sheet, row, column } = formula.stored;
    ids.set(cellKey(sheet, row, column), id);
    const columns = byColumn.get(sheet) ?? new Map<number, number[]>();
    byColumn.set(sheet, columns);
    const inColumn = columns.get(column);
    if (inColumn) inColumn.push(id);
    else columns.set(column, [id]);
    if (formula.area) {
      areas.push({ sheet, box: formula.area, id });
      const areaColumns = areasByColumn.get(sheet) ?? new Map<number, number[]>();
      areasByColumn.set(sheet, areaColumns);
      for (let at = formula.area.left; at <= formula.area.right; at++) {
        const owners = areaColumns.get(at);
        if (owners) owners.push(areas.length - 1);
        else areaColumns.set(at, [areas.length - 1]);
      }
    }
  });
  for (const columns of byColumn.values())
    for (const list of columns.values())
      list.sort((a, b) => formulas[a]!.stored.row - formulas[b]!.stored.row);
  const areaOwners = (sheet: string, box: CellBox) =>
    areas.filter(
      (area) =>
        area.sheet === sheet &&
        area.box.top <= box.bottom &&
        area.box.bottom >= box.top &&
        area.box.left <= box.right &&
        area.box.right >= box.left,
    );

  // Graph: formulas are nodes 0..n-1; a range read by several formulas is one
  // extra node, so a hundred SUM(A:A) cost one scan of column A, not a hundred.
  const dependents: number[][] = formulas.map(() => []);
  const indegree: number[] = formulas.map(() => 0);
  const ranges = new Map<string, number>();
  let links = 0;
  const link = (from: number, to: number) => {
    if (from === to) return;
    if (++links > limits.links) throw new Unsupported("a workbook too large to calculate here");
    dependents[from]!.push(to);
    indegree[to]! += 1;
  };
  const rangeNode = (sheet: string, box: CellBox) => {
    const key = `${sheetIndex.get(sheet.toLowerCase())}:${box.top}:${box.left}:${box.bottom}:${box.right}`;
    const known = ranges.get(key);
    if (known !== undefined) return known;
    const node = dependents.length;
    dependents.push([]);
    indegree.push(0);
    ranges.set(key, node);
    for (const [column, list] of byColumn.get(sheet) ?? [])
      if (column >= box.left && column <= box.right) {
        let low = 0;
        let high = list.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (formulas[list[middle]!]!.stored.row < box.top) low = middle + 1;
          else high = middle;
        }
        for (
          let index = low;
          index < list.length && formulas[list[index]!]!.stored.row <= box.bottom;
          index++
        )
          link(list[index]!, node);
      }
    for (const area of areaOwners(sheet, box)) link(area.id, node);
    return node;
  };
  const linkBox = (sheet: string, box: CellBox, id: number) => {
    if (box.top === box.bottom && box.left === box.right) {
      const source = ids.get(cellKey(sheet, box.top, box.left));
      if (source !== undefined) link(source, id);
      for (const area of areaOwners(sheet, box)) link(area.id, id);
    } else link(rangeNode(sheet, box), id);
  };
  try {
    formulas.forEach((formula, id) => {
      const pending = [...references(formula.node)];
      const seenNames = new Set<string>();
      while (pending.length) {
        const reference = pending.pop()!;
        if (reference.t === "name") {
          const key = reference.name.toLowerCase();
          if (seenNames.has(key)) continue;
          seenNames.add(key);
          const target = nameFor(formula.stored.sheet, reference.name);
          if (target) pending.push(...references(target));
          continue;
        }
        if (reference.t === "ref3d") {
          for (const sheet of between(reference.first, reference.last) ?? [])
            linkBox(sheet, reference.box, id);
          continue;
        }
        const sheet = reference.sheet === null ? formula.stored.sheet : sheetNamed(reference.sheet);
        if (sheet) linkBox(sheet, reference.box, id);
      }
    });
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    // Too many links to order here: every formula keeps the value it carried.
    return { result: { ...empty, unsupported: [error.what] }, reshaped: false };
  }

  // Kahn's order; what remains afterwards sits on or behind a cycle.
  const sequence: number[] = [];
  const ready = indegree.flatMap((count, node) => (count === 0 ? [node] : []));
  while (ready.length) {
    const node = ready.pop()!;
    if (node < formulas.length) sequence.push(node);
    for (const next of dependents[node]!) if (--indegree[next]! === 0) ready.push(next);
  }
  const ordered = new Set(sequence);

  const extents = new Map<string, { rows: number; columns: number }>();
  const extentOf = (sheet: string) => {
    let extent = extents.get(sheet);
    if (!extent) {
      extent = { ...store.extent(sheet) };
      extents.set(sheet, extent);
    }
    return extent;
  };

  // 0 waiting, 1 being computed, 2 done.
  const state = new Uint8Array(formulas.length);
  // Ranges read this pass, shared by every formula reading the same box. One read while a
  // formula in it was still being computed (a cycle) is not shared: its values were not final.
  const grids = new Map<string, Scalar[][]>();
  let unsettled = 0;
  let nested = 0;
  const demand = (id: number | undefined) => {
    if (id === undefined || state[id] !== 0 || !ordered.has(id)) return;
    if (nested >= MAX_NESTED) throw new Unsupported("references computed too deep");
    nested += 1;
    try {
      compute(id);
    } finally {
      nested -= 1;
    }
  };
  const scopeFor = (formula: Formula): Scope => {
    const volatile = store.volatile?.(formula.stored);
    return {
      ...(volatile ? { volatile } : {}),
      sheet: formula.stored.sheet,
      row: formula.stored.row,
      column: formula.stored.column,
      cell: (name, row, column) => {
        const sheet = sheetNamed(name);
        if (!sheet) return new XError("#REF!");
        // Only references computed at run time (INDIRECT, OFFSET) can reach a formula not yet done.
        const formulaAt = ids.get(cellKey(sheet, row, column));
        demand(formulaAt);
        if (formulaAt !== undefined && state[formulaAt] === 1) unsettled += 1;
        for (const at of areasByColumn.get(sheet)?.get(column) ?? []) {
          const area = areas[at]!;
          if (!inside(area.box, row, column)) continue;
          if (state[area.id] === 0) demand(area.id);
          if (state[area.id] === 1) unsettled += 1;
        }
        return store.value(sheet, row, column);
      },
      grid: (name, box, read) => {
        const sheet = sheetNamed(name);
        const key = `${sheet}\u0000${boxRef(box)}`;
        const known = grids.get(key);
        if (known) return known;
        const before = unsettled;
        const rows = read();
        if (unsettled === before) grids.set(key, rows);
        return rows;
      },
      clip: (name, box) => {
        const sheet = sheetNamed(name);
        if (!sheet) return null;
        const extent = extentOf(sheet);
        const clipped = {
          top: box.top,
          left: box.left,
          bottom: Math.min(box.bottom, extent.rows),
          right: Math.min(box.right, extent.columns),
        };
        return clipped.bottom < clipped.top || clipped.right < clipped.left ? null : clipped;
      },
      name: (name) => nameFor(formula.stored.sheet, name),
      sheets: (first, last) => between(first, last),
      isFormula: (name, row, column) => {
        const sheet = sheetNamed(name);
        return !!sheet && store.isFormula(sheet, row, column);
      },
      spill: (name, row, column) => {
        const sheet = sheetNamed(name);
        if (!sheet) return null;
        // A spill reference reads the formula's current extent, so it waits for the formula.
        demand(ids.get(cellKey(sheet, row, column)));
        return store.arrayArea(sheet, row, column);
      },
      parse: (text) => {
        try {
          return parseFormula(text, contextFor(formula.stored.sheet));
        } catch {
          return null;
        }
      },
    };
  };

  // Every error, listed in reading order (sheet, row, column) rather than the order formulas
  // happened to be calculated in, which a pass reusing results does not repeat.
  const flagged: Array<{ formula: StoredFormula; code: string }> = [];
  const flag = (formula: StoredFormula, code: string) => {
    flagged.push({ formula, code });
  };
  const record = (formula: Formula, result: Scalar, area?: CellBox) => {
    if (result instanceof XError) flag(formula.stored, result.code);
    store.setResult(formula.stored, result, area);
  };
  // Cells spilled into during this pass, by the formula that claimed them.
  const claimed = new Map<string, number>();
  let reshaped = false;

  /** Empties the plain values left in an array's area, outside `keep` and the anchor. */
  const clear = (formula: Formula, keep: CellBox | null) => {
    const box = formula.area;
    if (!box) return;
    const { sheet, row: anchorRow, column: anchorColumn } = formula.stored;
    for (let row = box.top; row <= box.bottom; row++)
      for (let column = box.left; column <= box.right; column++) {
        if (inside(keep, row, column) || (row === anchorRow && column === anchorColumn)) continue;
        store.clearValue(sheet, row, column);
      }
  };

  const spill = (formula: Formula, id: number, result: Scalar | Grid) => {
    const grid = result instanceof Grid ? result : new Grid([[result]]);
    const { sheet, row: top, column: left } = formula.stored;
    const area = {
      top,
      left,
      bottom: top + Math.max(grid.height, 1) - 1,
      right: left + Math.max(grid.width, 1) - 1,
    };
    const bounds = store.bounds(sheet);
    let blocked =
      area.bottom > Math.min(MAX_ROW, bounds.rows) ||
      area.right > Math.min(MAX_COLUMN, bounds.columns);
    if (!blocked && (area.bottom - area.top + 1) * (area.right - area.left + 1) > limits.spill)
      throw new Unsupported("a spill too large to write here");
    for (let row = area.top; row <= area.bottom && !blocked; row++)
      for (let column = area.left; column <= area.right && !blocked; column++) {
        if (row === top && column === left) continue;
        const owner = claimed.get(cellKey(sheet, row, column));
        blocked =
          (owner !== undefined && owner !== id) ||
          store.isFormula(sheet, row, column) ||
          (store.value(sheet, row, column) !== null && !inside(formula.area, row, column));
      }
    const kept = blocked ? null : area;
    clear(formula, kept);
    const anchor = own(formula.stored);
    // Formulas were ordered by the old shape; one that reads a newly spilled cell needs another pass.
    if (boxRef(formula.area ?? anchor) !== boxRef(kept ?? anchor)) {
      reshaped = true;
      // Cells it now covers or left were read as they were: ranges are read afresh.
      grids.clear();
    }
    record(formula, blocked ? new XError("#SPILL!") : (grid.rows[0]?.[0] ?? null), kept ?? anchor);
    if (kept) {
      grid.rows.forEach((line, r) =>
        line.forEach((item, c) => {
          if (r === 0 && c === 0) return;
          store.setValue(sheet, top + r, left + c, item);
          claimed.set(cellKey(sheet, top + r, left + c), id);
        }),
      );
      extents.delete(sheet);
    }
  };

  /** A legacy array formula fills exactly the range it was entered over. */
  const fill = (formula: Formula, result: Scalar | Grid) => {
    const { sheet, row: anchorRow, column: anchorColumn } = formula.stored;
    const box = formula.area!;
    const grid = result instanceof Grid ? result : new Grid([[result]]);
    const at = (r: number, c: number): Scalar => {
      const row = grid.height === 1 ? 0 : r;
      const column = grid.width === 1 ? 0 : c;
      return grid.rows[row]?.[column] ?? new XError("#N/A");
    };
    for (let row = box.top; row <= box.bottom; row++)
      for (let column = box.left; column <= box.right; column++)
        if (row !== anchorRow || column !== anchorColumn)
          store.setValue(sheet, row, column, at(row - box.top, column - box.left));
    record(formula, at(0, 0));
  };

  function compute(id: number) {
    const formula = formulas[id]!;
    state[id] = 1;
    try {
      const mode: Mode = formula.kind === "cse" ? "array" : formula.kind;
      const { value, lifted } = evaluateFormula(formula.node, scopeFor(formula), mode);
      const multiple = value instanceof Grid && (value.height !== 1 || value.width !== 1);
      if (formula.kind === "cse") fill(formula, value);
      else if (
        formula.kind === "dynamic" &&
        (formula.stored.form === "array" ||
          lifted ||
          multiple ||
          calls(formula.node, ARRAY_FUNCTIONS))
      )
        spill(formula, id, value);
      else record(formula, value instanceof Grid ? (value.rows[0]?.[0] ?? null) : value);
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      unsupported.add(error.what);
      // A new formula that will spill in Excel is saved as a dynamic one, for Excel to compute.
      if (
        formula.stored.authored &&
        formula.stored.form === "normal" &&
        calls(formula.node, ARRAY_FUNCTIONS)
      )
        store.setUncalculated(formula.stored, true);
    } finally {
      state[id] = 2;
    }
  }

  for (const id of sequence) if (state[id] === 0) compute(id);
  // Excel shows a circular reference as 0 and flags it; so does the report.
  for (const [id, formula] of formulas.entries()) {
    if (state[id] === 2) continue;
    store.setCircular(formula.stored);
    flag(formula.stored, "#CIRCULAR");
  }
  // New formulas the engine couldn't read keep no stale result, and one
  // calling an array function is saved dynamic, for Excel to spill.
  for (const stored of unread)
    store.setUncalculated(stored, stored.form === "normal" && ARRAY_CALL.test(stored.text));
  const errors: FormulaIssue[] = flagged
    .toSorted(
      (a, b) =>
        sheetIndex.get(a.formula.sheet.toLowerCase())! -
          sheetIndex.get(b.formula.sheet.toLowerCase())! ||
        a.formula.row - b.formula.row ||
        a.formula.column - b.formula.column,
    )
    .slice(0, limits.errorsListed)
    .map(({ formula, code }) => ({
      cell: address(formula.sheet, formula.row, formula.column),
      error: code,
    }));
  return {
    result: {
      formulas: formulas.length,
      errors,
      errorCount: flagged.length,
      unsupported: [...unsupported],
    },
    reshaped,
  };
}
