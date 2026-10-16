import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import type { Scalar } from "@chat/sheet/engine/values";
import { styleKey } from "@chat/sheet/style";
import { SheetGrid, type GridSheet, type SheetGridProps, type SheetSelection } from "./grid.tsx";
import { conditionalLooks } from "./looks.ts";
import { at } from "./test-sheet.ts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
/** A sheet of 300 rows and 80 columns, its cells and values given by A1-style row and column. */
function fixture(
  shape: Partial<GridSheet> = {},
  values: Record<string, Scalar> = {},
): Pick<SheetGridProps, "sheet" | "value"> {
  return {
    sheet: {
      name: "Sheet1",
      rows: Array.from({ length: 300 }, (_, i) => `r${i + 1}`),
      cols: Array.from({ length: 80 }, (_, i) => `c${i + 1}`),
      cells: {},
      rowProps: {},
      colProps: {},
      merges: [],
      freeze: { row: null, col: null },
      ...shape,
    },
    value: (r, c) => values[`${r}|${c}`] ?? null,
  };
}
function props(
  of: Pick<SheetGridProps, "sheet" | "value">,
  extra: Partial<SheetGridProps> = {},
): SheetGridProps {
  return {
    ...of,
    locale: EN_US,
    selection: { anchor: at(1, 1), head: at(1, 1) },
    onSelectionChange: () => {},
    label: "Window",
    ...extra,
  };
}
const cell = (row: number, col: number) =>
  document.querySelector<HTMLElement>(
    `[role="gridcell"][aria-rowindex="${row}"][aria-colindex="${col}"]`,
  );
function scroll(top: number, left = 0) {
  const grid = screen.getByRole("grid");
  grid.scrollTop = top;
  grid.scrollLeft = left;
  fireEvent.scroll(grid);
}
function uniqueActive(row: number, col: number) {
  const grid = screen.getByRole("grid");
  const id = grid.getAttribute("aria-activedescendant")!;
  expect([...document.querySelectorAll("[id]")].filter((node) => node.id === id)).toHaveLength(1);
  expect(document.getElementById(id)).toBe(cell(row, col));
  const coordinates = [...grid.querySelectorAll('[role="gridcell"]')].map(
    (node) => `${node.getAttribute("aria-rowindex")}:${node.getAttribute("aria-colindex")}`,
  );
  expect(new Set(coordinates).size).toBe(coordinates.length);
}

it("keeps the active column accessible when it leaves the drawn columns and returns", () => {
  render(<SheetGrid {...props(fixture())} />);
  for (const left of [2400, 0, 3200, 0]) {
    scroll(0, left);
    uniqueActive(1, 1);
  }
});

it("transfers a merge anchored above and left of the window exactly once, then back", () => {
  const sheet = fixture({ merges: [{ r1: "r2", r2: "r180", c1: "c2", c2: "c45" }] });
  render(<SheetGrid {...props(sheet, { selection: { anchor: at(2, 2), head: at(2, 2) } })} />);
  for (const [top, left] of [
    [0, 0],
    [1600, 2400],
    [3200, 2800],
    [0, 0],
  ]) {
    scroll(top!, left!);
    uniqueActive(2, 2);
    expect(cell(2, 2)?.style.height).toBe("3580px");
    expect(document.querySelectorAll('[aria-rowindex="2"][aria-colindex="2"]')).toHaveLength(1);
  }
});

it("draws a merge above the window even when it is not active", () => {
  render(
    <SheetGrid {...props(fixture({ merges: [{ r1: "r2", r2: "r180", c1: "c2", c2: "c4" }] }))} />,
  );
  scroll(2400);
  expect(cell(2, 2)?.style.height).toBe("3580px");
  uniqueActive(1, 1);
});

it("finds a spill to the left through hidden columns without crossing frozen columns", () => {
  const sheet = fixture(
    {
      freeze: { row: null, col: "c2" },
      colProps: { c9: { hidden: true } },
      cells: { r3: { c8: {} }, r4: { c2: {} }, r5: { c8: {}, c11: {} } },
    },
    {
      "r3|c8": "Visible origin ".repeat(30),
      "r4|c2": "Frozen origin ".repeat(30),
      "r5|c8": "Blocked origin ".repeat(30),
      "r5|c11": "Stop",
    },
  );
  render(<SheetGrid {...props(sheet)} />);
  scroll(0, 1600);
  expect(cell(3, 8)?.textContent).toContain("Visible origin");
  expect(cell(3, 8)?.className).toContain("overflow-visible");
  expect(cell(4, 2)).toBeNull();
  expect(cell(5, 8)).toBeNull();
  expect(cell(3, 9)).toBeNull();
});

it("repaints conditional looks, data bars and links in retained bands", () => {
  const plain = fixture({ cells: { r1: { c1: {} } } }, { "r1|c1": "Link" });
  const view = render(<SheetGrid {...props(plain)} />);
  expect(cell(1, 1)?.querySelector(".underline")).toBeNull();
  view.rerender(
    <SheetGrid
      {...props(plain)}
      looks={new Map([["r1|c1", { fill: "#ff0000", bar: { fraction: 0.75, color: "#00ff00" } }]])}
    />,
  );
  expect(cell(1, 1)?.style.backgroundColor).toBe("rgb(255, 0, 0)");
  expect(cell(1, 1)?.querySelector<HTMLElement>("[aria-hidden]")?.style.width).toBe(
    "calc(75% - 4px)",
  );
  view.rerender(<SheetGrid {...props(plain)} />);
  expect(cell(1, 1)?.style.backgroundColor).toBe("");
  const s = styleKey({ link: "https://example.com" })!;
  view.rerender(
    <SheetGrid {...props(fixture({ cells: { r1: { c1: { s } } } }, { "r1|c1": "Link" }))} />,
  );
  expect(cell(1, 1)?.querySelector(".underline")).not.toBeNull();
});

it("draws a keyboard jump's neighbouring cells synchronously without a scroll event", () => {
  const initial = props(fixture({ cells: { r280: { c60: {} } } }, { "r280|c60": "End" }));
  function Jump() {
    const [selection, onSelectionChange] = useState<SheetSelection>(initial.selection);
    return <SheetGrid {...initial} selection={selection} onSelectionChange={onSelectionChange} />;
  }
  render(<Jump />);
  expect(cell(279, 59)).toBeNull();
  fireEvent.keyDown(screen.getByRole("grid"), { key: "End", ctrlKey: true });
  expect(cell(279, 59)).not.toBeNull();
  uniqueActive(280, 60);
});

it("keeps the current viewport drawn until a smooth reveal actually scrolls", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const initial = props(fixture());
  const view = render(<SheetGrid {...initial} />);
  const grid = screen.getByRole("grid");
  const scrollTo = vi.fn();
  grid.scrollTo = scrollTo;
  scroll(3180);
  expect(cell(159, 1)).not.toBeNull();
  view.rerender(<SheetGrid {...initial} selection={{ anchor: at(174, 1), head: at(174, 1) }} />);
  expect(scrollTo).toHaveBeenCalledWith({ top: 3404, left: 12, behavior: "smooth" });
  expect(grid.scrollTop).toBe(3180);
  expect(cell(159, 1)).not.toBeNull();
  scroll(3404);
  expect(cell(174, 1)).not.toBeNull();
});

it("opens the merged anchor’s link from a covered cell", () => {
  const s = styleKey({ link: "https://example.com/stored" })!;
  const sheet = fixture(
    { merges: [{ r1: "r1", r2: "r1", c1: "c1", c2: "c3" }], cells: { r1: { c1: { s } } } },
    { "r1|c1": "Merged site" },
  );
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  render(<SheetGrid {...props(sheet)} />);
  expect(screen.getByText("Merged site").className).toContain("underline");
  const content = screen.getByRole("grid").querySelector("[data-sheet-content]")!;
  fireEvent.pointerDown(content, { button: 0, clientX: 70, clientY: 5, metaKey: true });
  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/stored",
    "_blank",
    "noopener,noreferrer",
  );
});

it("bounds sparse-row value lookups by the drawn cells, not the column distance", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  const wide = fixture({ cols: Array.from({ length: 1200 }, (_, i) => `c${i + 1}`) });
  const value = vi.fn(wide.value);
  render(<SheetGrid {...props({ ...wide, value })} />);
  for (const [top, left] of [
    [0, 63360],
    [320, 63360],
    [320, 65000],
  ]) {
    value.mockClear();
    scroll(top!, left!);
    const drawn = document.querySelectorAll('[role="gridcell"]').length;
    expect(drawn).toBeGreaterThan(0);
    expect(value.mock.calls.length).toBeLessThanOrEqual(drawn * 3);
  }
});

it("measures before paint again after a keyed sheet switch", () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240);
  const initial = props(fixture());
  const view = render(<SheetGrid key="first" {...initial} />);
  expect(cell(1, 14)).toBeNull();
  width.mockReturnValue(960);
  view.rerender(<SheetGrid key="second" {...initial} />);
  expect(cell(1, 14)).not.toBeNull();
});

it("skips zero-height bands and keeps a merge whose anchor is hidden", () => {
  const hidden = Object.fromEntries(
    Array.from({ length: 48 }, (_, i) => [`r${i + 1}`, { hidden: true as const }]),
  );
  const sheet = fixture({
    rowProps: hidden,
    merges: [{ r1: "r10", r2: "r60", c1: "c2", c2: "c3" }],
  });
  render(<SheetGrid {...props(sheet, { selection: { anchor: at(49, 1), head: at(49, 1) } })} />);
  expect(screen.queryByRole("rowheader", { name: "20" })).toBeNull();
  expect(cell(20, 1)).toBeNull();
  expect(cell(10, 2)?.style.height).toBe("240px");
  expect(document.querySelectorAll('[aria-rowindex="10"][aria-colindex="2"]')).toHaveLength(1);
});

it("draws a merge and a conditional format over the whole sheet without visiting its cells", () => {
  const rows = Array.from({ length: 1_048_576 }, (_, i) => `r${i + 1}`);
  const cols = Array.from({ length: 16_384 }, (_, i) => `c${i + 1}`);
  const whole = { r1: "r2", r2: rows.at(-1)!, c1: "c1", c2: cols.at(-1)! };
  const value = vi.fn((r: string, c: string): Scalar =>
    r === "r1" && c === "c1" ? 5 : r === "r9" && c === "c1" ? 7 : null,
  );
  const sheet = fixture({
    rows,
    cols,
    cells: { r1: { c1: {} }, r9: { c1: {} } },
    merges: [whole],
    conditional: [{ box: { ...whole, r1: "r1" }, rule: { kind: "bar", color: "#638EC6" } }],
  }).sheet;
  const looks = conditionalLooks(sheet, value, EN_US);
  expect([...looks.keys()]).toEqual(["r1|c1", "r9|c1"]);
  expect(value.mock.calls.length).toBe(2);
  render(<SheetGrid {...props({ sheet, value }, { looks })} />);
  expect(cell(2, 1)?.style.height).toBe(`${(1_048_576 - 1) * 20}px`);
  expect(cell(3, 1)).toBeNull();
});

it("keeps a freeze larger than the window to what fits, so the rest still scrolls", () => {
  const sheet = fixture(
    {
      rows: Array.from({ length: 100_000 }, (_, i) => `r${i + 1}`),
      freeze: { row: "r50000", col: "c60" },
      cells: { r24: { c1: {} }, r25: { c1: {} } },
    },
    { "r24|c1": "Last frozen", "r25|c1": "First scrolled" },
  );
  render(<SheetGrid {...props(sheet)} />);
  expect(document.querySelectorAll('[role="rowheader"]').length).toBeLessThan(500);
  // The fallback window is 640 high: 24 rows fit in three quarters of it.
  scroll(4000);
  // Frozen panes are drawn copies, hidden from the accessibility tree.
  const shown = document.body.textContent ?? "";
  expect(shown).toContain("Last frozen");
  expect(shown).not.toContain("First scrolled");
});

it("shares one budget for conditional formats across a sheet's rules", () => {
  const rule = { kind: "bar", color: "#638EC6" } as const;
  const box = { r1: "r1", c1: "c1", r2: "r300", c2: "c80" };
  const sheet = fixture(
    { cells: { r1: { c1: {} } }, conditional: Array.from({ length: 200 }, () => ({ box, rule })) },
    { "r1|c1": 5 },
  );
  const value = vi.fn(sheet.value);
  const looks = conditionalLooks(sheet.sheet, value, EN_US);
  expect(looks.get("r1|c1")?.bar?.fraction).toBe(1);
  // 24,000 cells a rule: eight rules weigh them all, and one read serves every rule.
  expect(value.mock.calls.length).toBe(24_000);
});
