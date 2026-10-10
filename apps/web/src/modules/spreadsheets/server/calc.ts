import {
  isFormulaValue,
  type Cell,
  type CellValue,
  type FormulaValue,
} from "@office-kit/xlsx/cell";
import { iterWorksheets, type Workbook } from "@office-kit/xlsx/workbook";
import { getCell, iterCells, setCell, type Worksheet } from "@office-kit/xlsx/worksheet";
import { boxRef, parseRange } from "@chat/sheet/a1";
import { SPREADSHEET_LIMITS } from "../limits.ts";
import { isDynamic, markDynamic } from "./dynamic-arrays.ts";
import {
  calculate,
  type CalcReport,
  type CellStore,
  type FormulaIssue,
  type StoredFormula,
} from "@chat/sheet/engine/calculate";
import { XError, type Scalar } from "@chat/sheet/engine/evaluate";
import type { TableShape } from "@chat/sheet/engine/parse";

export type { CalcReport, FormulaIssue };

export interface CalcOptions {
  /**
   * Formulas written in this edit. They follow Excel 365 (dynamic arrays); a
   * formula already in the file without the dynamic mark is a legacy one.
   */
  readonly authored?: ReadonlySet<Cell>;
}

/** A workbook's room to calculate in; past it, Excel calculates on open instead. */
const FILE_LIMITS = {
  errorsListed: SPREADSHEET_LIMITS.errorsListed,
  links: 5_000_000,
  spill: 200_000,
};
/** Days from Excel's 1900 epoch (as Excel counts it) to the Unix epoch. */
const EXCEL_UNIX_DAYS = 25_569;

/** A stored value as the engine reads it. */
export function scalarOf(value: CellValue): Scalar {
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
/** A formula without its previous result, whose error marker must not outlive it. */
const withoutResult = (value: FormulaValue) => {
  const { cachedValue: _value, cachedValueType: _type, ...base } = value;
  return base;
};

/** The Excel file library's workbook as cell storage for the calculation. */
function workbookStore(workbook: Workbook, authored: ReadonlySet<Cell>): CellStore {
  const sheets = new Map<string, Worksheet>();
  for (const sheet of iterWorksheets(workbook)) sheets.set(sheet.title.toLowerCase(), sheet);
  const sheetOf = (name: string) => sheets.get(name.toLowerCase());
  const raw = (name: string, row: number, column: number) =>
    sheetOf(name)?.rows.get(row)?.get(column)?.value ?? null;
  // Each stored formula's cell, so results land on the cell it came from.
  const cells = new Map<StoredFormula, Cell>();
  const write = (formula: StoredFormula, value: CellValue) => {
    cells.get(formula)!.value = value;
  };
  const formulaOf = (formula: StoredFormula) => cells.get(formula)!.value as FormulaValue;
  return {
    sheets: [...sheets.values()].map((sheet) => sheet.title),
    *formulas() {
      cells.clear();
      for (const sheet of sheets.values())
        for (const cell of iterCells(sheet)) {
          const value = cell.value;
          if (!isFormulaValue(value) || !value.formula) continue;
          if (value.t !== "normal" && value.t !== "array") continue;
          const stored: StoredFormula = {
            sheet: sheet.title,
            row: cell.row,
            column: cell.col,
            text: value.formula,
            form: value.t,
            dynamic: value.t === "array" && isDynamic(workbook, sheet, cell),
            area: value.t === "array" && value.ref ? parseRange(value.ref) : null,
            authored: authored.has(cell),
          };
          cells.set(stored, cell);
          yield stored;
        }
    },
    *names() {
      for (const name of workbook.definedNames)
        if (!name.name.startsWith("_xlnm."))
          yield { name: name.name, scope: name.scope ?? null, text: name.value };
    },
    tables() {
      const tables = new Map<string, TableShape>();
      for (const sheet of sheets.values())
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
    },
    value: (sheet, row, column) => scalarOf(raw(sheet, row, column)),
    isFormula: (sheet, row, column) => isFormulaValue(raw(sheet, row, column)),
    arrayArea: (sheet, row, column) => {
      const value = raw(sheet, row, column);
      return isFormulaValue(value) && value.t === "array" && value.ref
        ? parseRange(value.ref)
        : null;
    },
    extent: (name) => {
      const extent = { rows: 0, columns: 0 };
      for (const [row, columns] of sheetOf(name)?.rows ?? []) {
        extent.rows = Math.max(extent.rows, row);
        for (const column of columns.keys()) extent.columns = Math.max(extent.columns, column);
      }
      return extent;
    },
    setResult: (formula, result, area) => {
      const current = withoutResult(formulaOf(formula));
      const shaped: FormulaValue = area ? { ...current, t: "array", ref: boxRef(area) } : current;
      write(
        formula,
        result instanceof XError
          ? { ...shaped, cachedValue: result.code, cachedValueType: "error" }
          : { ...shaped, cachedValue: result ?? 0 },
      );
      if (area) markDynamic(workbook, sheetOf(formula.sheet)!, cells.get(formula)!);
    },
    setValue: (sheet, row, column, value) => {
      setCell(sheetOf(sheet)!, row, column, cellValueOf(value));
    },
    clearValue: (sheet, row, column) => {
      const cell = getCell(sheetOf(sheet)!, row, column);
      if (cell && cell.value !== null && !isFormulaValue(cell.value)) cell.value = null;
    },
    setUncalculated: (formula, dynamic) => {
      const base = withoutResult(formulaOf(formula));
      if (!dynamic) return write(formula, base);
      write(formula, {
        ...base,
        t: "array",
        ref: boxRef({
          top: formula.row,
          left: formula.column,
          bottom: formula.row,
          right: formula.column,
        }),
      });
      markDynamic(workbook, sheetOf(formula.sheet)!, cells.get(formula)!);
    },
    setCircular: (formula) => {
      const { cachedValueType: _previous, ...base } = formulaOf(formula);
      write(formula, { ...base, cachedValue: 0 });
    },
  };
}

/**
 * Evaluates every formula in a workbook and stores each result as its cached
 * value, so the model, previews and any reader of the file see results. What
 * the engine doesn't evaluate keeps the file's value; Excel recalculates on
 * open anyway.
 */
export function recalculate(workbook: Workbook, options: CalcOptions = {}): CalcReport {
  return calculate(workbookStore(workbook, options.authored ?? new Set()), FILE_LIMITS);
}
