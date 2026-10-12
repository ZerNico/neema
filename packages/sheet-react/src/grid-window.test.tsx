import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import { calculateSheet } from "@chat/sheet/model/calc";
import { EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { SheetGrid, type SheetGridProps, type SheetSelection } from "./grid.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const at = (row: number, col: number) => ({ r: `s1.r${row}`, c: `s1.c${col}` });
function fixture(): SheetDoc {
  const base = emptyDoc();
  return {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        rows: Array.from({ length: 300 }, (_, i) => ({ id: at(i + 1, 1).r })),
        cols: Array.from({ length: 80 }, (_, i) => ({ id: at(1, i + 1).c })),
      },
    },
  };
}
function props(doc: SheetDoc, extra: Partial<SheetGridProps> = {}): SheetGridProps {
  return {
    doc,
    sheet: "s1",
    values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45000, seed: 1 }),
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
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        merges: [{ r1: "s1.r2", r2: "s1.r180", c1: "s1.c2", c2: "s1.c45" }],
      },
    },
  };
  render(<SheetGrid {...props(doc, { selection: { anchor: at(2, 2), head: at(2, 2) } })} />);
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
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: { ...base.sheet.s1!, merges: [{ r1: "s1.r2", r2: "s1.r180", c1: "s1.c2", c2: "s1.c4" }] },
    },
  };
  render(<SheetGrid {...props(doc)} />);
  scroll(2400);
  expect(cell(2, 2)?.style.height).toBe("3580px");
  uniqueActive(1, 1);
});

it("finds a spill to the left through hidden columns without crossing frozen columns", () => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        freeze: { row: null, col: "s1.c2" },
        colProps: { "s1.c9": { hidden: true as const } },
        cells: {
          "s1.r3": { "s1.c8": { v: "Visible origin ".repeat(30), w: 1 } },
          "s1.r4": { "s1.c2": { v: "Frozen origin ".repeat(30), w: 1 } },
          "s1.r5": {
            "s1.c8": { v: "Blocked origin ".repeat(30), w: 1 },
            "s1.c11": { v: "Stop", w: 1 },
          },
        },
      },
    },
  };
  render(<SheetGrid {...props(doc)} />);
  scroll(0, 1600);
  expect(cell(3, 8)?.textContent).toContain("Visible origin");
  expect(cell(3, 8)?.className).toContain("overflow-visible");
  expect(cell(4, 2)).toBeNull();
  expect(cell(5, 8)).toBeNull();
  expect(cell(3, 9)).toBeNull();
});

it("indexes calculated spill origins and blockers, but ignores hidden occupied columns", () => {
  const base = fixture();
  const label = "Spilled origin ".repeat(30);
  const formula = parseFormula(`{"seed";"${label}"}`, { doc: base, sheet: "s1" });
  const blocker = parseFormula("SEQUENCE(2)", { doc: base, sheet: "s1" });
  if (!("formula" in formula) || !("formula" in blocker)) throw new Error("needs growth");
  const doc = {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        colProps: { "s1.c9": { hidden: true as const } },
        merges: [{ r1: "s1.r7", r2: "s1.r7", c1: "s1.c10", c2: "s1.c11" }],
        cells: {
          "s1.r2": { "s1.c8": { f: formula.formula, w: 1 } },
          "s1.r3": { "s1.c9": { v: "Hidden blocker", w: 1 } },
          "s1.r5": { "s1.c11": { f: blocker.formula, w: 1 } },
          "s1.r6": { "s1.c8": { v: "Blocked by spill ".repeat(30), w: 1 } },
          "s1.r7": { "s1.c8": { v: "Blocked by merge ".repeat(30), w: 1 } },
        },
      },
    },
  };
  const initial = props(doc);
  expect(initial.values.value("s1", "s1.r3", "s1.c8")).toBe(label);
  expect(initial.values.value("s1", "s1.r6", "s1.c11")).toBe(2);
  render(<SheetGrid {...initial} />);
  scroll(0, 1600);
  expect(cell(3, 8)?.textContent).toBe(label);
  expect(cell(3, 8)?.className).toContain("overflow-visible");
  expect(cell(3, 9)).toBeNull();
  expect(cell(6, 8)).toBeNull();
  expect(cell(7, 8)).toBeNull();
});

it.each([
  [1, 1],
  [1, 4],
  [4, 1],
  [4, 4],
])("keeps the editor accessible in pane at row %i column %i", (row, col) => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: { s1: { ...base.sheet.s1!, freeze: { row: "s1.r2", col: "s1.c2" } } },
  };
  render(
    <SheetGrid
      {...props(doc, {
        selection: { anchor: at(row, col), head: at(row, col) },
        editing: { at: at(row, col), text: "editing", mode: "edit" },
        onEditingChange: () => {},
        onCommit: () => {},
      })}
    />,
  );
  expect(screen.getByRole("textbox")).toBeTruthy();
  uniqueActive(row, col);
});

it("finishes a header resize after its row has unmounted and retains the pointer-down zoom", () => {
  const onResize = vi.fn();
  const onEditingChange = vi.fn();
  const initial = props(fixture(), { zoom: 2, onResize, onEditingChange, onCommit: () => {} });
  const view = render(<SheetGrid {...initial} />);
  const grid = screen.getByRole("grid");
  const capture = vi.fn();
  grid.setPointerCapture = capture;
  const header = screen.getByRole("rowheader", { name: "3" });
  const edge = header.querySelector("[aria-hidden]")!;
  fireEvent.pointerDown(edge, { button: 0, pointerId: 7, clientY: 100 });
  expect(capture).toHaveBeenCalledWith(7);
  scroll(5000);
  expect(header.isConnected).toBe(false);
  view.rerender(<SheetGrid {...initial} zoom={1} />);
  fireEvent.pointerMove(grid, { pointerId: 7, clientY: 140 });
  fireEvent.pointerUp(grid, { pointerId: 7, clientY: 140 });
  expect(onResize).toHaveBeenCalledExactlyOnceWith("rows", "s1.r3", 40);
  expect(onEditingChange).not.toHaveBeenCalled();
});

it("cancels a resize and refuses an in-flight resize after becoming read-only", () => {
  const onResize = vi.fn();
  const initial = props(fixture(), { onResize, onEditingChange: () => {}, onCommit: () => {} });
  const view = render(<SheetGrid {...initial} />);
  const grid = screen.getByRole("grid");
  const edge = screen.getByRole("columnheader", { name: "A" }).querySelector("[aria-hidden]")!;
  fireEvent.pointerDown(edge, { button: 0, pointerId: 1, clientX: 10 });
  fireEvent.pointerCancel(grid, { pointerId: 1 });
  fireEvent.pointerUp(grid, { pointerId: 1, clientX: 100 });
  expect(onResize).not.toHaveBeenCalled();
  fireEvent.pointerDown(edge, { button: 0, pointerId: 2, clientX: 10 });
  view.rerender(<SheetGrid {...initial} readOnly />);
  fireEvent.pointerUp(grid, { pointerId: 2, clientX: 100 });
  expect(onResize).not.toHaveBeenCalled();
  expect(screen.getByRole("columnheader", { name: "A" }).querySelector("[aria-hidden]")).toBeNull();
});

it("autofits in stored pixels and does not start editing on the double-click", () => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        cells: { "s1.r1": { "s1.c1": { v: "A long label to fit", w: 1 } } },
      },
    },
  };
  const onResize = vi.fn();
  const onEditingChange = vi.fn();
  const initial = props(doc, { onResize, onEditingChange, onCommit: () => {} });
  const view = render(<SheetGrid {...initial} zoom={1} />);
  fireEvent.doubleClick(
    screen.getByRole("columnheader", { name: "A" }).querySelector("[aria-hidden]")!,
  );
  view.rerender(<SheetGrid {...initial} zoom={2} />);
  fireEvent.doubleClick(
    screen.getByRole("columnheader", { name: "A" }).querySelector("[aria-hidden]")!,
  );
  expect(onResize).toHaveBeenCalledTimes(2);
  expect(onResize.mock.calls[0]).toEqual(onResize.mock.calls[1]);
  expect(onResize.mock.calls[0]![2]).toBeGreaterThan(64);
  expect(onEditingChange).not.toHaveBeenCalled();
});

it("repaints conditional looks, data bars, stored links and calculated links in retained bands", () => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: { s1: { ...base.sheet.s1!, cells: { "s1.r1": { "s1.c1": { v: "Link", w: 1 } } } } },
  };
  const initial = props(doc);
  const view = render(<SheetGrid {...initial} />);
  expect(cell(1, 1)?.querySelector(".underline")).toBeNull();
  view.rerender(
    <SheetGrid
      {...initial}
      looks={
        new Map([["s1.r1|s1.c1", { fill: "#ff0000", bar: { fraction: 0.75, color: "#00ff00" } }]])
      }
      values={{ ...initial.values, link: () => "https://example.com" }}
    />,
  );
  expect(cell(1, 1)?.style.backgroundColor).toBe("rgb(255, 0, 0)");
  expect(cell(1, 1)?.querySelector<HTMLElement>("[aria-hidden]")?.style.width).toBe(
    "calc(75% - 4px)",
  );
  expect(cell(1, 1)?.querySelector(".underline")).not.toBeNull();
  view.rerender(<SheetGrid {...initial} />);
  expect(cell(1, 1)?.style.backgroundColor).toBe("");
  expect(cell(1, 1)?.querySelector(".underline")).toBeNull();
  const linked = applyChange(
    doc,
    {
      clientId: "test",
      seq: 1,
      ops: [
        {
          op: "format",
          sh: "s1",
          area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
          patch: { link: "https://example.com" },
        },
      ],
    },
    2,
  ).doc;
  view.rerender(<SheetGrid {...initial} doc={linked} />);
  expect(cell(1, 1)?.querySelector(".underline")).not.toBeNull();
});

it("keeps a filter menu's anchor element through a one-band scroll", () => {
  let anchor: HTMLElement | null = null;
  render(
    <SheetGrid
      {...props(fixture(), {
        filterButtons: { row: "s1.r40", cols: ["s1.c1"], active: new Set() },
        onFilterButton: (_col, button) => {
          anchor = button;
        },
      })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Filter A" }));
  scroll(320);
  expect(anchor).toBe(screen.getByRole("button", { name: "Filter A" }));
  expect(document.contains(anchor)).toBe(true);
});

it("draws a keyboard jump's neighbouring cells synchronously without a scroll event", () => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: { s1: { ...base.sheet.s1!, cells: { "s1.r280": { "s1.c60": { v: "End", w: 1 } } } } },
  };
  const initial = props(doc);
  function Jump() {
    const [selection, onSelectionChange] = useState<SheetSelection | null>(initial.selection);
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
  const initial = props(fixture(), { selection: null });
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

it.each([false, true])(
  "opens the merged anchor’s link from a covered cell (stored: %s)",
  (stored) => {
    const base = fixture();
    const formula = parseFormula('HYPERLINK("https://example.com/formula", "Merged site")', {
      doc: base,
      sheet: "s1",
    });
    if (!("formula" in formula)) throw new Error("needs growth");
    const doc = {
      ...base,
      sheet: {
        s1: {
          ...base.sheet.s1!,
          merges: [{ r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c3" }],
          cells: {
            "s1.r1": {
              "s1.c1": {
                f: formula.formula,
                ...(stored ? { s: JSON.stringify({ link: "https://example.com/stored" }) } : {}),
                w: 1,
              },
            },
          },
        },
      },
    };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<SheetGrid {...props(doc)} />);
    expect(screen.getByText("Merged site").className).toContain("underline");
    const content = screen.getByRole("grid").querySelector("[data-sheet-content]")!;
    fireEvent.pointerDown(content, { button: 0, clientX: 70, clientY: 5, metaKey: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(
      stored ? "https://example.com/stored" : "https://example.com/formula",
      "_blank",
      "noopener,noreferrer",
    );
  },
);

it("bounds sparse-row value lookups by the drawn cells, not the column distance", () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: {
        ...base.sheet.s1!,
        cols: Array.from({ length: 1200 }, (_, i) => ({ id: at(1, i + 1).c })),
      },
    },
  };
  const initial = props(doc, { selection: null });
  const value = vi.fn(initial.values.value);
  render(<SheetGrid {...initial} values={{ ...initial.values, value }} />);
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
  const initial = props(fixture(), { selection: null });
  const view = render(<SheetGrid key="first" {...initial} />);
  expect(cell(1, 14)).toBeNull();
  width.mockReturnValue(960);
  view.rerender(<SheetGrid key="second" {...initial} />);
  expect(cell(1, 14)).not.toBeNull();
});

it("skips zero-height bands and keeps a merge whose anchor is hidden", () => {
  const base = fixture();
  const doc = {
    ...base,
    sheet: {
      s1: { ...base.sheet.s1!, merges: [{ r1: "s1.r10", r2: "s1.r60", c1: "s1.c2", c2: "s1.c3" }] },
    },
  };
  const hiddenRows = new Set(Array.from({ length: 48 }, (_, i) => `s1.r${i + 1}`));
  render(<SheetGrid {...props(doc, { selection: null, hiddenRows })} />);
  expect(screen.queryByRole("rowheader", { name: "20" })).toBeNull();
  expect(cell(20, 1)).toBeNull();
  expect(cell(10, 2)?.style.height).toBe("240px");
  expect(document.querySelectorAll('[aria-rowindex="10"][aria-colindex="2"]')).toHaveLength(1);
});
