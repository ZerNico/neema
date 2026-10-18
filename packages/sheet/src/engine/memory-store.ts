import { boxRef, MAX_COLUMN, MAX_ROW, parseCell, type CellBox } from "../a1.ts";
import type { CellStore, StoredFormula } from "./calculate.ts";
import type { Scalar } from "./evaluate.ts";

const key = (row: number, column: number) => `${row}:${column}`;

/** Plain storage, no workbook: the calculation alone. */
export function memoryStore(
  cells: Record<string, Scalar | `=${string}`>,
  names: Record<string, string> = {},
) {
  type Entry = { value: Scalar; formula?: string; area?: CellBox | null };
  const grid = new Map<string, Entry>();
  for (const [address, content] of Object.entries(cells)) {
    const { row, column } = parseCell(address)!;
    grid.set(
      key(row, column),
      typeof content === "string" && content.startsWith("=")
        ? { value: null, formula: content.slice(1) }
        : { value: content },
    );
  }
  const read = (row: number, column: number) => grid.get(key(row, column));
  const formulaAt = (formula: StoredFormula) => read(formula.row, formula.column)!;
  const store: CellStore = {
    sheets: ["Sheet1"],
    *formulas() {
      for (const [at, entry] of grid) {
        if (entry.formula === undefined) continue;
        const [row, column] = at.split(":").map(Number) as [number, number];
        yield {
          sheet: "Sheet1",
          row,
          column,
          text: entry.formula,
          form: entry.area ? "array" : "normal",
          dynamic: !!entry.area,
          area: entry.area ?? null,
          authored: true,
        };
      }
    },
    *names() {
      for (const [name, text] of Object.entries(names)) yield { name, scope: null, text };
    },
    tables: () => new Map(),
    value: (_sheet, row, column) => read(row, column)?.value ?? null,
    isFormula: (_sheet, row, column) => read(row, column)?.formula !== undefined,
    arrayArea: (_sheet, row, column) => read(row, column)?.area ?? null,
    bounds: () => ({ rows: MAX_ROW, columns: MAX_COLUMN }),
    extent: () => {
      let rows = 0;
      let columns = 0;
      for (const at of grid.keys()) {
        const [row, column] = at.split(":").map(Number) as [number, number];
        rows = Math.max(rows, row);
        columns = Math.max(columns, column);
      }
      return { rows, columns };
    },
    setResult: (formula, result, area) => {
      const entry = formulaAt(formula);
      entry.value = result;
      if (area) entry.area = area;
    },
    setValue: (_sheet, row, column, value) => {
      grid.set(key(row, column), { value });
    },
    clearValue: (_sheet, row, column) => {
      const entry = read(row, column);
      if (entry && entry.formula === undefined) grid.delete(key(row, column));
    },
    setUncalculated: (formula) => {
      formulaAt(formula).value = null;
    },
    setCircular: (formula) => {
      formulaAt(formula).value = 0;
    },
  };
  const at = (address: string) => {
    const { row, column } = parseCell(address)!;
    return read(row, column)?.value ?? null;
  };
  const set = (address: string, value: Scalar) => {
    const { row, column } = parseCell(address)!;
    grid.set(key(row, column), { value });
  };
  const area = (address: string) => {
    const { row, column } = parseCell(address)!;
    const box = read(row, column)?.area;
    return box ? boxRef(box) : null;
  };
  /** The values a formula filled, row by row; a single result is a one-cell grid. */
  const spilled = (address: string): Scalar[][] => {
    const { row, column } = parseCell(address)!;
    const box = read(row, column)?.area ?? { top: row, left: column, bottom: row, right: column };
    const rows: Scalar[][] = [];
    for (let r = box.top; r <= box.bottom; r++) {
      const line: Scalar[] = [];
      for (let c = box.left; c <= box.right; c++) line.push(read(r, c)?.value ?? null);
      rows.push(line);
    }
    return rows;
  };
  return { store, at, set, area, spilled };
}
