import {
  isFormulaValue,
  type Cell,
  type CellValue,
  type FormulaValue,
} from "@office-kit/xlsx/cell";
import { iterWorksheets, type Workbook } from "@office-kit/xlsx/workbook";
import { getCell, iterCells, setCell, type Worksheet } from "@office-kit/xlsx/worksheet";
import {
  boxRef,
  columnLetters,
  MAX_COLUMN,
  MAX_ROW,
  parseRange,
  type CellBox,
} from "../operations.ts";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import { isDynamic, markDynamic } from "./dynamic-arrays.ts";
import {
  evaluateFormula,
  Grid,
  XError,
  type Mode,
  type Scalar,
  type Scope,
} from "./engine/evaluate.ts";
import {
  calls,
  parseFormula,
  references,
  Unsupported,
  type Node,
  type ParseContext,
  type TableShape,
} from "./engine/parse.ts";

export interface FormulaIssue {
  readonly cell: string;
  readonly error: string;
}
export interface CalcReport {
  readonly formulas: number;
  /** Cells whose formula evaluates to an error, bounded; `errorCount` is the full count. */
  readonly errors: readonly FormulaIssue[];
  readonly errorCount: number;
  /** What the engine doesn't evaluate; those cells keep the value the file carried. */
  readonly unsupported: readonly string[];
}
export interface CalcOptions {
  /**
   * Formulas written in this edit. They follow Excel 365 (dynamic arrays); a
   * formula already in the file without the dynamic mark is a legacy one.
   */
  readonly authored?: ReadonlySet<Cell>;
}

/** Dependency links one calculation may build; past it, Excel calculates on open instead. */
const MAX_LINKS = 5_000_000;
/** Cells one formula may spill into. */
const MAX_SPILL = 200_000;
/** Formulas computed out of order, one inside another, for references known only at run time. */
const MAX_NESTED = 100;
/** Spills that change shape move what other formulas read; each pass settles one more round. */
const MAX_PASSES = 3;
/** Days from Excel's 1900 epoch (as Excel counts it) to the Unix epoch. */
const EXCEL_UNIX_DAYS = 25_569;

/** Functions whose result is an array: Excel 365 always saves them as dynamic formulas. */
const ARRAY_FUNCTIONS = new Set([
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
/** The same functions as they appear in file text, for formulas the engine can't parse. */
const ARRAY_CALL = new RegExp(
  `(?<![\\w.])(?:_xlfn\\.(?:_xlws\\.)?)?(?:${[...ARRAY_FUNCTIONS].join("|")})\\s*\\(`,
  "i",
);

/** A stored value as the engine reads it. */
function scalarOf(value: CellValue): Scalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return value;
  if (value instanceof Date) return value.getTime() / 86_400_000 + EXCEL_UNIX_DAYS;
  if (isFormulaValue(value))
    return value.cachedValueType === "error"
      ? new XError(String(value.cachedValue))
      : (value.cachedValue ?? null);
  if (value.kind === "duration") return value.ms / 86_400_000;
  if (value.kind === "error") return new XError(value.code);
  return value.runs.map((run) => run.text).join("");
}
const cellValueOf = (value: Scalar): CellValue =>
  value instanceof XError ? { kind: "error", code: value.code as `#${string}` } : value;

/**
 * - `legacy`: a plain formula from the file, read by implicit intersection
 * - `dynamic`: Excel 365's, spilling; a plain one written in this edit becomes one if it needs to
 * - `cse`: a legacy array formula, filling the range it was entered over
 */
type Kind = "legacy" | "dynamic" | "cse";
interface Formula {
  readonly sheet: Worksheet;
  readonly cell: Cell;
  readonly value: FormulaValue;
  readonly node: Node;
  readonly kind: Kind;
  readonly authored: boolean;
  /** The cells an array formula filled last time, its own included. */
  readonly area: CellBox | null;
}

const cellKey = (sheet: string, row: number, column: number) =>
  `${sheet.toLowerCase()}\u0000${row}\u0000${column}`;
const inside = (box: CellBox | null, row: number, column: number) =>
  !!box && row >= box.top && row <= box.bottom && column >= box.left && column <= box.right;
const address = (sheet: Worksheet, row: number, column: number) =>
  `${sheet.title}!${columnLetters(column)}${row}`;

function tableShapes(workbook: Workbook) {
  const tables = new Map<string, TableShape>();
  for (const sheet of iterWorksheets(workbook))
    for (const table of sheet.tables) {
      const box = parseRange(table.ref);
      if (!box) continue;
      tables.set(table.displayName.toLowerCase(), {
        sheet: sheet.title,
        box,
        headerRows: table.headerRowCount ?? 1,
        totalsRows: table.totalsRowCount ?? 0,
        columns: table.columns.map((column) => column.name),
      });
    }
  return tables;
}

/**
 * Evaluates every formula in dependency order and stores each result as the
 * formula's cached value, so the model, previews and any reader of the file
 * see results. Dynamic formulas spill into the cells beside them, as Excel
 * 365 does. The order is built without recursion, so a long chain of cells
 * each reading the one above can't overflow the stack. What the engine
 * doesn't evaluate keeps the file's value; Excel recalculates on open anyway.
 */
export function recalculate(workbook: Workbook, options: CalcOptions = {}): CalcReport {
  let report = pass(workbook, options);
  for (let passes = 1; report.reshaped && passes < MAX_PASSES; passes++)
    report = pass(workbook, options);
  return report.result;
}

/** Empties the plain values left in an array's area, outside `keep` and the anchor. */
const clear = (sheet: Worksheet, box: CellBox | null, keep: CellBox | null, anchor: Cell) => {
  if (!box) return;
  for (let row = box.top; row <= box.bottom; row++)
    for (let column = box.left; column <= box.right; column++) {
      if (inside(keep, row, column) || (row === anchor.row && column === anchor.col)) continue;
      const cell = getCell(sheet, row, column);
      if (cell && cell.value !== null && !isFormulaValue(cell.value)) cell.value = null;
    }
};

function pass(workbook: Workbook, options: CalcOptions) {
  const authored = options.authored ?? new Set<Cell>();
  const sheets = new Map<string, Worksheet>();
  const order: Worksheet[] = [];
  for (const sheet of iterWorksheets(workbook)) {
    sheets.set(sheet.title.toLowerCase(), sheet);
    order.push(sheet);
  }
  const tables = tableShapes(workbook);
  const contextFor = (sheet: Worksheet, row?: number, column?: number): ParseContext => ({
    table: (name) => {
      if (name) return tables.get(name.toLowerCase()) ?? null;
      if (row === undefined || column === undefined) return null;
      for (const table of tables.values())
        if (table.sheet === sheet.title && inside(table.box, row, column)) return table;
      return null;
    },
    ...(row === undefined ? {} : { row }),
  });

  const unsupported = new Set<string>();
  const formulas: Formula[] = [];
  const unread: Array<{ sheet: Worksheet; cell: Cell; value: FormulaValue }> = [];
  for (const sheet of order)
    for (const cell of iterCells(sheet)) {
      const value = cell.value;
      if (!isFormulaValue(value) || !value.formula) continue;
      if (value.t !== "normal" && value.t !== "array") continue;
      const dynamic = value.t === "array" && isDynamic(workbook, sheet, cell);
      const kind: Kind =
        value.t === "normal"
          ? authored.has(cell)
            ? "dynamic"
            : "legacy"
          : dynamic
            ? "dynamic"
            : "cse";
      const area = value.t === "array" ? (value.ref ? parseRange(value.ref) : null) : null;
      try {
        formulas.push({
          sheet,
          cell,
          value,
          node: parseFormula(value.formula, contextFor(sheet, cell.row, cell.col)),
          kind,
          authored: authored.has(cell),
          area:
            area ??
            (value.t === "array"
              ? { top: cell.row, bottom: cell.row, left: cell.col, right: cell.col }
              : null),
        });
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        unsupported.add(error.what);
        if (authored.has(cell)) unread.push({ sheet, cell, value });
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
  for (const name of workbook.definedNames) {
    if (name.name.startsWith("_xlnm.")) continue;
    let node: Node | null = null;
    try {
      node = parseFormula(name.value, {
        table: (table) => (table ? (tables.get(table.toLowerCase()) ?? null) : null),
      });
    } catch {
      // A name the engine can't read leaves its users at #NAME?, which is reported.
    }
    names.set(`${name.scope ?? "*"}\u0000${name.name.toLowerCase()}`, node);
  }
  const sheetIndex = new Map(order.map((sheet, index) => [sheet, index]));
  const nameFor = (sheet: Worksheet, name: string) => {
    const scoped = `${sheetIndex.get(sheet)}\u0000${name.toLowerCase()}`;
    return names.has(scoped)
      ? names.get(scoped)!
      : (names.get(`*\u0000${name.toLowerCase()}`) ?? null);
  };
  const between = (first: string, last: string) => {
    const a = sheets.get(first.toLowerCase());
    const b = sheets.get(last.toLowerCase());
    if (!a || !b) return null;
    const [from, to] = [sheetIndex.get(a)!, sheetIndex.get(b)!].toSorted((x, y) => x - y);
    return order.slice(from, to! + 1);
  };

  // Formula cells by sheet and column, sorted by row, to find those inside a range.
  const ids = new Map<string, number>();
  const byColumn = new Map<Worksheet, Map<number, number[]>>();
  // An array formula owns the cells it filled: reading one waits for it.
  const areas: Array<{ sheet: Worksheet; box: CellBox; id: number }> = [];
  // The same areas by sheet and column, so reading a cell asks only those that could own it.
  const areasByColumn = new Map<Worksheet, Map<number, number[]>>();
  formulas.forEach((formula, id) => {
    ids.set(cellKey(formula.sheet.title, formula.cell.row, formula.cell.col), id);
    const columns = byColumn.get(formula.sheet) ?? new Map<number, number[]>();
    byColumn.set(formula.sheet, columns);
    columns.set(formula.cell.col, [...(columns.get(formula.cell.col) ?? []), id]);
    if (formula.area) {
      areas.push({ sheet: formula.sheet, box: formula.area, id });
      const areaColumns = areasByColumn.get(formula.sheet) ?? new Map<number, number[]>();
      areasByColumn.set(formula.sheet, areaColumns);
      for (let column = formula.area.left; column <= formula.area.right; column++)
        areaColumns.set(column, [...(areaColumns.get(column) ?? []), areas.length - 1]);
    }
  });
  for (const columns of byColumn.values())
    for (const list of columns.values())
      list.sort((a, b) => formulas[a]!.cell.row - formulas[b]!.cell.row);
  const areaOwners = (sheet: Worksheet, box: CellBox) =>
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
    if (++links > MAX_LINKS) throw new Unsupported("a workbook too large to calculate here");
    dependents[from]!.push(to);
    indegree[to]! += 1;
  };
  const rangeNode = (sheet: Worksheet, box: CellBox) => {
    const key = `${sheetIndex.get(sheet)}:${box.top}:${box.left}:${box.bottom}:${box.right}`;
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
          if (formulas[list[middle]!]!.cell.row < box.top) low = middle + 1;
          else high = middle;
        }
        for (
          let index = low;
          index < list.length && formulas[list[index]!]!.cell.row <= box.bottom;
          index++
        )
          link(list[index]!, node);
      }
    for (const area of areaOwners(sheet, box)) link(area.id, node);
    return node;
  };
  const linkBox = (sheet: Worksheet, box: CellBox, id: number) => {
    if (box.top === box.bottom && box.left === box.right) {
      const source = ids.get(cellKey(sheet.title, box.top, box.left));
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
          const target = nameFor(formula.sheet, reference.name);
          if (target) pending.push(...references(target));
          continue;
        }
        if (reference.t === "ref3d") {
          for (const sheet of between(reference.first, reference.last) ?? [])
            linkBox(sheet, reference.box, id);
          continue;
        }
        const sheet =
          reference.sheet === null ? formula.sheet : sheets.get(reference.sheet.toLowerCase());
        if (sheet) linkBox(sheet, reference.box, id);
      }
    });
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    // Too many links to order here: every formula keeps the file's value.
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

  const extents = new Map<Worksheet, { rows: number; columns: number }>();
  const extentOf = (sheet: Worksheet) => {
    let extent = extents.get(sheet);
    if (!extent) {
      extent = { rows: 0, columns: 0 };
      for (const [row, columns] of sheet.rows) {
        extent.rows = Math.max(extent.rows, row);
        for (const column of columns.keys()) extent.columns = Math.max(extent.columns, column);
      }
      extents.set(sheet, extent);
    }
    return extent;
  };

  // 0 waiting, 1 being computed, 2 done.
  const state = new Uint8Array(formulas.length);
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
  const scopeFor = (formula: Formula): Scope => ({
    sheet: formula.sheet.title,
    row: formula.cell.row,
    column: formula.cell.col,
    cell: (name, row, column) => {
      const sheet = sheets.get(name.toLowerCase());
      if (!sheet) return new XError("#REF!");
      // Only references computed at run time (INDIRECT, OFFSET) can reach a formula not yet done.
      demand(ids.get(cellKey(sheet.title, row, column)));
      for (const at of areasByColumn.get(sheet)?.get(column) ?? []) {
        const area = areas[at]!;
        if (state[area.id] === 0 && inside(area.box, row, column)) demand(area.id);
      }
      return scalarOf(sheet.rows.get(row)?.get(column)?.value ?? null);
    },
    clip: (name, box) => {
      const sheet = sheets.get(name.toLowerCase());
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
    name: (name) => nameFor(formula.sheet, name),
    sheets: (first, last) => between(first, last)?.map((sheet) => sheet.title) ?? null,
    isFormula: (name, row, column) => {
      const value = sheets.get(name.toLowerCase())?.rows.get(row)?.get(column)?.value;
      return isFormulaValue(value ?? null);
    },
    spill: (name, row, column) => {
      const sheet = sheets.get(name.toLowerCase());
      if (!sheet) return null;
      // A spill reference reads the formula's current extent, so it waits for the formula.
      demand(ids.get(cellKey(sheet.title, row, column)));
      const value = sheet.rows.get(row)?.get(column)?.value ?? null;
      return isFormulaValue(value) && value.t === "array" && value.ref
        ? parseRange(value.ref)
        : null;
    },
    parse: (text) => {
      try {
        return parseFormula(text, contextFor(formula.sheet));
      } catch {
        return null;
      }
    },
  });

  const errors: FormulaIssue[] = [];
  let errorCount = 0;
  const flag = (formula: Formula, code: string) => {
    errorCount += 1;
    if (errors.length < SPREADSHEET_LIMITS.errorsListed)
      errors.push({
        cell: address(formula.sheet, formula.cell.row, formula.cell.col),
        error: code,
      });
  };
  const withResult = (formula: Formula, value: FormulaValue, result: Scalar): FormulaValue => {
    // The previous result's error marker must not outlive it.
    const { cachedValueType: _previous, cachedValue: _value, ...base } = value;
    if (result instanceof XError) {
      flag(formula, result.code);
      return { ...base, cachedValue: result.code, cachedValueType: "error" };
    }
    return { ...base, cachedValue: result ?? 0 };
  };
  // Cells spilled into during this pass, by the formula that claimed them.
  const claimed = new Map<string, number>();
  let reshaped = false;

  const spill = (formula: Formula, id: number, result: Scalar | Grid) => {
    const grid = result instanceof Grid ? result : new Grid([[result]]);
    const { sheet, cell } = formula;
    const area = {
      top: cell.row,
      left: cell.col,
      bottom: cell.row + Math.max(grid.height, 1) - 1,
      right: cell.col + Math.max(grid.width, 1) - 1,
    };
    let blocked = area.bottom > MAX_ROW || area.right > MAX_COLUMN;
    if (!blocked && (area.bottom - area.top + 1) * (area.right - area.left + 1) > MAX_SPILL)
      throw new Unsupported("a spill too large to write here");
    for (let row = area.top; row <= area.bottom && !blocked; row++)
      for (let column = area.left; column <= area.right && !blocked; column++) {
        if (row === cell.row && column === cell.col) continue;
        const key = cellKey(sheet.title, row, column);
        const owner = claimed.get(key);
        const value = sheet.rows.get(row)?.get(column)?.value ?? null;
        blocked =
          (owner !== undefined && owner !== id) ||
          isFormulaValue(value) ||
          (value !== null && !inside(formula.area, row, column));
      }
    const kept = blocked ? null : area;
    clear(sheet, formula.area, kept, cell);
    const own = { top: cell.row, left: cell.col, bottom: cell.row, right: cell.col };
    const next = boxRef(kept ?? own);
    // Formulas were ordered by the old shape; one that reads a newly spilled cell needs another pass.
    if (boxRef(formula.area ?? own) !== next) reshaped = true;
    const top = blocked ? new XError("#SPILL!") : (grid.rows[0]?.[0] ?? null);
    cell.value = withResult(formula, { ...formula.value, t: "array", ref: next }, top);
    markDynamic(workbook, sheet, cell);
    if (kept) {
      grid.rows.forEach((line, r) =>
        line.forEach((item, c) => {
          if (r === 0 && c === 0) return;
          setCell(sheet, cell.row + r, cell.col + c, cellValueOf(item));
          claimed.set(cellKey(sheet.title, cell.row + r, cell.col + c), id);
        }),
      );
      extents.delete(sheet);
    }
  };

  /** A legacy array formula fills exactly the range it was entered over. */
  const fill = (formula: Formula, result: Scalar | Grid) => {
    const { sheet, cell } = formula;
    const box = formula.area!;
    const grid = result instanceof Grid ? result : new Grid([[result]]);
    const at = (r: number, c: number): Scalar => {
      const row = grid.height === 1 ? 0 : r;
      const column = grid.width === 1 ? 0 : c;
      return grid.rows[row]?.[column] ?? new XError("#N/A");
    };
    for (let row = box.top; row <= box.bottom; row++)
      for (let column = box.left; column <= box.right; column++)
        if (row !== cell.row || column !== cell.col)
          setCell(sheet, row, column, cellValueOf(at(row - box.top, column - box.left)));
    cell.value = withResult(formula, formula.value, at(0, 0));
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
        (formula.value.t === "array" || lifted || multiple || calls(formula.node, ARRAY_FUNCTIONS))
      )
        spill(formula, id, value);
      else {
        const top = value instanceof Grid ? (value.rows[0]?.[0] ?? null) : value;
        formula.cell.value = withResult(formula, formula.value, top);
      }
    } catch (error) {
      if (!(error instanceof Unsupported)) throw error;
      unsupported.add(error.what);
      // A new formula that will spill in Excel is saved as a dynamic one, for Excel to compute.
      if (
        formula.authored &&
        formula.value.t === "normal" &&
        calls(formula.node, ARRAY_FUNCTIONS)
      ) {
        const { cachedValue: _value, cachedValueType: _type, ...base } = formula.value;
        formula.cell.value = {
          ...base,
          t: "array",
          ref: boxRef({
            top: formula.cell.row,
            left: formula.cell.col,
            bottom: formula.cell.row,
            right: formula.cell.col,
          }),
        };
        markDynamic(workbook, formula.sheet, formula.cell);
      }
    } finally {
      state[id] = 2;
    }
  }

  for (const id of sequence) if (state[id] === 0) compute(id);
  // Excel shows a circular reference as 0 and flags it; so does the report.
  for (const [id, formula] of formulas.entries()) {
    if (state[id] === 2) continue;
    const { cachedValueType: _previous, ...base } = formula.value;
    formula.cell.value = { ...base, cachedValue: 0 };
    flag(formula, "#CIRCULAR");
  }
  // New formulas the engine couldn't read keep no stale result for Excel to show, and
  // one calling an array function is saved dynamic, for Excel to spill.
  for (const { sheet, cell, value } of unread) {
    const { cachedValue: _value, cachedValueType: _type, ...base } = value;
    if (base.t === "normal" && ARRAY_CALL.test(base.formula)) {
      cell.value = {
        ...base,
        t: "array",
        ref: boxRef({ top: cell.row, left: cell.col, bottom: cell.row, right: cell.col }),
      };
      markDynamic(workbook, sheet, cell);
    } else cell.value = base;
  }
  return {
    result: { formulas: formulas.length, errors, errorCount, unsupported: [...unsupported] },
    reshaped,
  };
}
