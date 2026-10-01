import { isFormulaValue, makeFormula, type Cell, type CellValue } from "@office-kit/xlsx/cell";
import { fromArrayBuffer, loadWorkbook } from "@office-kit/xlsx/io";
import { getSheet } from "@office-kit/xlsx/workbook";
import { getCell, type Worksheet } from "@office-kit/xlsx/worksheet";
import { columnLetters } from "../../operations.ts";
import { recalculate } from "../calc.ts";
import { dynamicCells, isDynamic, markDynamic, readDynamicCells } from "../dynamic-arrays.ts";
import { toEngineFormula } from "../formulas.ts";
import { PARITY_BLOCK } from "./parity-cases.ts";

/** A case's result as either side computed it: a number, text, boolean, error code, or nothing. */
export type Outcome =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "text" | "error"; readonly value: string }
  | { readonly type: "boolean"; readonly value: boolean }
  | { readonly type: "none" };

function outcomeOf(value: CellValue | undefined): Outcome {
  if (value === null || value === undefined) return { type: "none" };
  if (isFormulaValue(value)) {
    if (value.cachedValue === undefined) return { type: "none" };
    if (value.cachedValueType === "error")
      return { type: "error", value: String(value.cachedValue) };
    return outcomeOf(value.cachedValue);
  }
  if (typeof value === "number") return { type: "number", value };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "text", value };
  if (value instanceof Date) return { type: "text", value: value.toISOString() };
  if (value.kind === "error") return { type: "error", value: value.code };
  if (value.kind === "rich-text")
    return { type: "text", value: value.runs.map((run) => run.text).join("") };
  return { type: "number", value: value.ms / 86_400_000 };
}

/** Codes Excel saves as #VALUE! in the cell, keeping the real one in rich-value metadata. */
const RICH_ERRORS = new Set([
  "#SPILL!",
  "#CALC!",
  "#FIELD!",
  "#BLOCKED!",
  "#CONNECT!",
  "#BUSY!",
  "#UNKNOWN!",
]);

/**
 * Numbers agree to 12 significant digits, since Excel itself stores 15 and
 * rounds some functions. `excel` comes first: its #VALUE! stands for any code
 * it keeps as a rich value.
 */
export const sameOutcome = (excel: Outcome, ours: Outcome) => {
  if (
    excel.type === "error" &&
    excel.value === "#VALUE!" &&
    ours.type === "error" &&
    RICH_ERRORS.has(ours.value)
  )
    return true;
  const [a, b] = [excel, ours];
  if (a.type !== b.type) return false;
  if (a.type === "number" && b.type === "number")
    return (
      a.value === b.value ||
      Math.abs(a.value - b.value) <= 1e-12 * Math.max(1, Math.abs(a.value), Math.abs(b.value))
    );
  return a.type === "none" || ("value" in b && a.value === b.value);
};
export const showOutcome = (outcome: Outcome) =>
  outcome.type === "none" ? "(empty)" : `${outcome.type}:${JSON.stringify(outcome.value)}`;

/** An Excel-saved parity workbook, with its dynamic formulas known. */
export async function openParityWorkbook(bytes: Uint8Array) {
  const workbook = await loadWorkbook(fromArrayBuffer(bytes.slice().buffer));
  readDynamicCells(workbook, bytes);
  const dynamic = getSheet(workbook, "Dynamic")!;
  const probe = outcomeOf(getCell(getSheet(workbook, "Other")!, 1, 4)?.value);
  return {
    workbook,
    locale: "value" in probe ? String(probe.value) : "",
    dynamic: dynamicCells(workbook).get(dynamic)?.size ?? 0,
  };
}

export interface ParityCase {
  readonly sheet: "Legacy" | "Dynamic";
  readonly label: string;
  readonly formula: string;
  /** The formula's own cell, then (Dynamic only) every other cell of its block that holds a value. */
  readonly excel: ReadonlyMap<string, Outcome>;
  readonly ours: ReadonlyMap<string, Outcome>;
  /** Dynamic only: whether the file Excel saved marks the formula dynamic, and whether we would. */
  readonly marked?: { readonly excel: boolean; readonly ours: boolean };
}

const blockCells = (sheet: Worksheet, top: number) => {
  const cells: Cell[] = [];
  for (let row = top; row < top + PARITY_BLOCK.rows; row++)
    for (let column = 2; column < 2 + PARITY_BLOCK.columns; column++) {
      const cell = getCell(sheet, row, column);
      if (cell) cells.push(cell);
    }
  return cells;
};
const snapshot = (cells: readonly Cell[]) =>
  new Map(
    cells
      .map((cell) => [`${columnLetters(cell.col)}${cell.row}`, outcomeOf(cell.value)] as const)
      .filter(([, outcome]) => outcome.type !== "none"),
  );

/**
 * Every case in an Excel-saved workbook: Excel's result, then ours after
 * clearing every result Excel wrote and recalculating from scratch. Formulas
 * on `Dynamic` are entered afresh, marks dropped, as a model's would be: the
 * engine decides the mark again, and Excel computed an unmarked one as legacy,
 * so a mark it should have written shows up as a difference.
 */
export async function compareWithExcel(bytes: Uint8Array): Promise<ParityCase[]> {
  const { workbook } = await openParityWorkbook(bytes);
  const legacy = getSheet(workbook, "Legacy")!;
  const dynamic = getSheet(workbook, "Dynamic")!;
  const pending: Array<{
    sheet: ParityCase["sheet"];
    label: string;
    formula: string;
    cells: () => Cell[];
    excel: Map<string, Outcome>;
    anchor?: Cell;
    wasMarked?: boolean;
  }> = [];
  const authored = new Set<Cell>();
  const clear = (cell: Cell, anchor: boolean) => {
    const value = cell.value;
    if (anchor && isFormulaValue(value)) {
      const { cachedValue: _value, cachedValueType: _type, ...formula } = value;
      cell.value = formula;
    } else if (!anchor) cell.value = null;
  };
  for (let row = 1; ; row++) {
    const cell = getCell(legacy, row, 2);
    if (!cell || !isFormulaValue(cell.value)) break;
    const excel = snapshot([cell]);
    pending.push({
      sheet: "Legacy",
      label: String(getCell(legacy, row, 1)?.value ?? ""),
      formula: toEngineFormula(cell.value.formula),
      cells: () => [cell],
      excel,
    });
    clear(cell, true);
  }
  for (let top = 1; ; top += PARITY_BLOCK.rows) {
    const anchor = getCell(dynamic, top, 2);
    if (!anchor || !isFormulaValue(anchor.value)) break;
    const cells = blockCells(dynamic, top);
    const excel = snapshot(cells);
    const wasMarked = isDynamic(workbook, dynamic, anchor);
    pending.push({
      sheet: "Dynamic",
      label: String(getCell(dynamic, top, 1)?.value ?? ""),
      formula: toEngineFormula(anchor.value.formula),
      cells: () => blockCells(dynamic, top),
      excel,
      anchor,
      wasMarked,
    });
    for (const cell of cells) clear(cell, cell === anchor);
    // Every case is entered afresh, as a model's formula would be, so the engine
    // decides again which need the dynamic mark and must spill as Excel did.
    anchor.value = makeFormula(anchor.value.formula);
    markDynamic(workbook, dynamic, anchor, false);
    authored.add(anchor);
  }
  recalculate(workbook, { authored });
  return pending.map(({ cells, anchor, wasMarked, ...item }) => ({
    ...item,
    ours: snapshot(cells()),
    ...(anchor
      ? { marked: { excel: wasMarked ?? false, ours: isDynamic(workbook, dynamic, anchor) } }
      : {}),
  }));
}

/** Whether both sides filled the same cells with the same results. */
export function sameCase(item: ParityCase) {
  const keys = new Set([...item.excel.keys(), ...item.ours.keys()]);
  return [...keys].every((key) =>
    sameOutcome(item.excel.get(key) ?? { type: "none" }, item.ours.get(key) ?? { type: "none" }),
  );
}
export function describeCase(item: ParityCase) {
  const keys = [...new Set([...item.excel.keys(), ...item.ours.keys()])];
  const differing = keys.filter(
    (key) =>
      !sameOutcome(item.excel.get(key) ?? { type: "none" }, item.ours.get(key) ?? { type: "none" }),
  );
  return differing
    .slice(0, 4)
    .map(
      (key) =>
        `${key} excel ${showOutcome(item.excel.get(key) ?? { type: "none" })} ours ${showOutcome(item.ours.get(key) ?? { type: "none" })}`,
    )
    .join("; ");
}
