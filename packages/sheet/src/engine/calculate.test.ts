import { describe, expect, it } from "vitest";
import { boxRef, MAX_COLUMN, MAX_ROW, parseCell, type CellBox } from "../a1.ts";
import { calculate, type CellStore, type StoredFormula } from "./calculate.ts";
import { XError, type Scalar } from "./evaluate.ts";

/** Plain storage, no workbook: the calculation alone. */
function memoryStore(
  cells: Record<string, Scalar | `=${string}`>,
  names: Record<string, string> = {},
) {
  type Entry = { value: Scalar; formula?: string; area?: CellBox | null };
  const grid = new Map<string, Entry>();
  const key = (row: number, column: number) => `${row}:${column}`;
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
  return { store, at, set, area };
}

const limits = { errorsListed: 10, links: 10_000, spill: 10_000 };

describe("calculation over any storage", () => {
  it("orders formulas by what they read, whatever order storage gives them in", () => {
    const sheet = memoryStore({ A3: "=A2*2", A2: "=A1+1", A1: 4, B1: '=INDIRECT("A3")+1' });
    const report = calculate(sheet.store, limits);
    expect([sheet.at("A2"), sheet.at("A3"), sheet.at("B1")]).toEqual([5, 10, 11]);
    expect(report).toMatchObject({ formulas: 3, errorCount: 0 });
  });

  it("reads a range once for every formula reading it, and afresh once a spill reshapes", () => {
    const cells: Record<string, Scalar | `=${string}`> = { A1: 3, B1: "=A1*2" };
    for (let row = 2; row <= 100; row++) cells[`B${row}`] = row;
    for (let row = 1; row <= 50; row++) cells[`C${row}`] = "=SUM($B$1:$B$100)";
    // Read before and after the spill it sums takes its shape this pass.
    Object.assign(cells, { D1: "=SEQUENCE(A1)", E1: "=SUM(D1:D9)", E2: "=SUM(D1:D9)" });
    const sheet = memoryStore(cells);
    let reads = 0;
    const value = sheet.store.value;
    sheet.store.value = (...args) => {
      reads += 1;
      return value(...args);
    };
    calculate(sheet.store, limits);
    const total = 6 + (100 * 101) / 2 - 1;
    expect([sheet.at("C1"), sheet.at("C50")]).toEqual([total, total]);
    expect([sheet.at("E1"), sheet.at("E2")]).toEqual([6, 6]);
    // Fifty sums of a hundred cells, read as one range a pass rather than five thousand reads.
    expect(reads).toBeLessThan(1_000);
  });

  it("does not share a range read while a formula in it was still being computed", () => {
    // A1 computes B1 through INDIRECT, and B1 reads A1:A2 while A1 is still unfinished.
    const sheet = memoryStore({
      A1: '=INDIRECT("B1")+1',
      A2: 5,
      B1: "=SUM(A1:A2)",
      C1: "=SUM(A1:A2)",
    });
    calculate(sheet.store, limits);
    expect([sheet.at("B1"), sheet.at("A1")]).toEqual([5, 6]);
    // C1 reads the range once A1 is done, not as B1 saw it.
    expect(sheet.at("C1")).toBe(11);
  });

  it("takes the statistics of a column longer than a call takes arguments", () => {
    const cells: Record<string, Scalar | `=${string}`> = {
      B1: "=MEDIAN(A1:A150000)",
      B2: "=MAX(A1:A150000)",
      B3: "=SKEW(A1:A150000)",
      C1: "=MEDIAN(5,1,3)",
      C2: "=MEDIAN(1,2,3,4)",
      C3: '=MEDIAN("x")',
    };
    for (let row = 1; row <= 150_000; row++) cells[`A${row}`] = row;
    const sheet = memoryStore(cells);
    calculate(sheet.store, { ...limits, links: 1_000_000 });
    expect([sheet.at("B1"), sheet.at("B2")]).toEqual([75_000.5, 150_000]);
    expect(sheet.at("B3")).toBeCloseTo(0, 9);
    expect([sheet.at("C1"), sheet.at("C2"), sheet.at("C3")]).toEqual([
      3,
      2.5,
      new XError("#VALUE!"),
    ]);
  });

  it("spills, is blocked by a value in the way, and spills again once it is gone", () => {
    const sheet = memoryStore({ A1: "=SEQUENCE(3)", A3: "in the way" });
    const blocked = calculate(sheet.store, limits);
    expect(sheet.at("A1")).toEqual(new XError("#SPILL!"));
    expect(blocked.errors).toEqual([{ cell: "Sheet1!A1", error: "#SPILL!" }]);
    sheet.set("A3", null);
    calculate(sheet.store, limits);
    expect([sheet.at("A1"), sheet.at("A2"), sheet.at("A3")]).toEqual([1, 2, 3]);
    expect(sheet.area("A1")).toBe("A1:A3");
  });

  it("shows a cycle as 0 and reports it, and resolves names", () => {
    const sheet = memoryStore(
      { A1: "=B1+1", B1: "=A1+1", C1: "=Rate*10", D1: 0.5 },
      { Rate: "Sheet1!D1" },
    );
    const report = calculate(sheet.store, limits);
    expect([sheet.at("A1"), sheet.at("B1"), sheet.at("C1")]).toEqual([0, 0, 5]);
    expect(report.errorCount).toBe(2);
    expect(report.errors.map((error) => error.error)).toEqual(["#CIRCULAR", "#CIRCULAR"]);
  });
});
