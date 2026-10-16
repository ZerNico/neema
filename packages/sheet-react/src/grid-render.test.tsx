import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import { SheetGrid, type GridSheet, type SheetSelection } from "./grid.tsx";

const calls = vi.hoisted(() => ({
  cells: [] as { first: number; main: boolean }[],
  headers: [] as number[],
}));
vi.mock("./grid-bands.tsx", async (original) => {
  const actual = await original<typeof import("./grid-bands.tsx")>();
  // Keep the production wrapper and comparator. A plain export must stay plain.
  const instrument = <P,>(component: object, body: (props: P) => import("react").ReactNode) =>
    typeof component === "function" ? body : { ...component, type: body };
  return {
    ...actual,
    CellBand: instrument(
      actual.CellBand,
      function CountCellBand(props: import("./grid-bands.tsx").CellBandProps) {
        calls.cells.push({ first: props.first, main: props.main });
        return actual.CellBandBody(props);
      },
    ),
    RowHeaderBand: instrument(
      actual.RowHeaderBand,
      function CountHeaderBand(props: import("./grid-bands.tsx").RowHeaderBandProps) {
        calls.headers.push(props.first);
        return actual.RowHeaderBandBody(props);
      },
    ),
  };
});
afterEach(cleanup);
const rows = Array.from({ length: 280 }, (_, i) => `r${i}`);
const cols = Array.from({ length: 16 }, (_, i) => `c${i}`);
const sheet: GridSheet = {
  name: "Sheet1",
  rows,
  cols,
  cells: Object.fromEntries(rows.map((r) => [r, Object.fromEntries(cols.map((c) => [c, {}]))])),
  rowProps: {},
  colProps: {},
  merges: [],
  freeze: { row: "r1", col: "c1" },
};
const value = (r: string, c: string) => `${r}/${c}`;
function Harness() {
  const [selection, setSelection] = useState<SheetSelection>({
    anchor: { r: "r3", c: "c3" },
    head: { r: "r3", c: "c3" },
  });
  return (
    <SheetGrid
      sheet={sheet}
      value={value}
      locale={EN_US}
      selection={selection}
      onSelectionChange={setSelection}
      label="Grid"
    />
  );
}
function reset() {
  calls.cells.length = 0;
  calls.headers.length = 0;
}

it("makes no band calls or DOM mutations inside the pixel window's hysteresis", () => {
  render(<Harness />);
  const grid = screen.getByRole("grid");
  const delivered: MutationRecord[] = [];
  const observer = new MutationObserver((records) => delivered.push(...records));
  observer.observe(grid, { subtree: true, attributes: true, childList: true, characterData: true });
  reset();
  grid.scrollTop = 150;
  fireEvent.scroll(grid);
  expect(calls.cells).toEqual([]);
  expect(calls.headers).toEqual([]);
  expect([...delivered, ...observer.takeRecords()]).toEqual([]);
  observer.disconnect();
});

it("runs only the entering main, row-header and frozen-left bands on a one-band scroll", () => {
  render(<Harness />);
  reset();
  const grid = screen.getByRole("grid");
  grid.scrollTop = 320;
  fireEvent.scroll(grid);
  expect(calls.cells).toEqual([
    { first: 80, main: false },
    { first: 80, main: true },
  ]);
  expect(calls.headers).toEqual([80]);
  expect(document.querySelector('[aria-rowindex="96"][aria-colindex="4"]')).not.toBeNull();
});

it("runs one cell band when ArrowDown keeps the active cell in that band", () => {
  render(<Harness />);
  reset();
  fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
  expect(calls.cells).toEqual([{ first: 0, main: true }]);
  expect(calls.headers).toEqual([0]);
  const grid = screen.getByRole("grid");
  expect(
    document
      .getElementById(grid.getAttribute("aria-activedescendant")!)
      ?.getAttribute("aria-rowindex"),
  ).toBe("5");
});
