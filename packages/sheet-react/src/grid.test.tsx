import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DE_DE, EN_US, type SheetLocale } from "@chat/sheet/locales";
import { SheetGrid, type GridOverlay, type SheetSelection } from "./grid.tsx";
import { conditionalLooks } from "./looks.ts";
import { at, testSheet } from "./test-sheet.ts";

afterEach(cleanup);

type Built = ReturnType<typeof testSheet>;
function Harness({
  built,
  locale = EN_US,
  overlays,
}: {
  built: Built;
  locale?: SheetLocale;
  overlays?: readonly GridOverlay[];
}) {
  const [selection, setSelection] = useState<SheetSelection>({ anchor: at(1, 1), head: at(1, 1) });
  return (
    <div>
      <output data-testid="selection">
        {`${selection.anchor.r}/${selection.anchor.c}-${selection.head.r}/${selection.head.c}`}
      </output>
      <SheetGrid
        sheet={built.sheet}
        value={built.value}
        locale={locale}
        selection={selection}
        onSelectionChange={setSelection}
        label="Budget"
        looks={conditionalLooks(built.sheet, built.value, locale)}
        {...(overlays ? { overlays } : {})}
      />
    </div>
  );
}

const cellText = (row: number, col: number) =>
  document.querySelector(`[aria-rowindex="${row}"][aria-colindex="${col}"]`)?.textContent;
const shown = () => screen.getByTestId("selection").textContent;
const contentOf = () => screen.getByRole("grid").firstElementChild!.lastElementChild!;

describe("the sheet grid", () => {
  it("shows values as their format and locale write them, and says it only reads", () => {
    const format = { numberFormat: "#,##0.00" };
    render(
      <Harness
        built={testSheet({
          A1: { value: 1234.5, style: format },
          A3: { value: 1236.5, style: format },
          B1: "Rent",
        })}
        locale={DE_DE}
      />,
    );
    expect(cellText(1, 1)).toBe("1.234,50");
    expect(cellText(3, 1)).toBe("1.236,50");
    expect(cellText(1, 2)).toBe("Rent");
    expect(screen.getByRole("grid", { name: "Budget" }).getAttribute("aria-readonly")).toBe("true");
  });

  it("runs text on over empty cells only as far as it needs, its fill staying in its cell", () => {
    const long = "A much longer label than one column holds";
    render(
      <Harness
        built={testSheet({ A1: "Short", A2: { value: long, style: { fill: "#DDEBF7" } } })}
      />,
    );
    const cell = (text: string) => screen.getByText(text).parentElement!;
    expect(cell("Short").style.width).toBe("64px");
    expect(cell("Short").nextElementSibling?.getAttribute("aria-hidden")).toBeNull();
    expect(cell(long).style.width).toBe("64px");
    // The text runs over a strip of the empty cells beside it, which keeps their bottom line.
    const spill = cell(long).previousElementSibling as HTMLElement;
    expect(Number.parseInt(spill.style.width)).toBeGreaterThanOrEqual(128);
    expect(spill.style.backgroundColor).toBe("");
  });

  it("draws a viewport ahead and redraws only after scrolling half of one", () => {
    render(<Harness built={testSheet({ A60: "ahead", A90: "further", A130: "far" })} />);
    const grid = screen.getByRole("grid");
    // jsdom has no layout: the grid assumes a 640-pixel viewport, rows 20 pixels high.
    expect(cellText(60, 1)).toBe("ahead");
    expect(cellText(90, 1)).toBeUndefined();
    grid.scrollTop = 300;
    fireEvent.scroll(grid);
    expect(cellText(90, 1)).toBeUndefined();
    grid.scrollTop = 700;
    fireEvent.scroll(grid);
    expect(cellText(90, 1)).toBe("further");
    expect(cellText(130, 1)).toBeUndefined();
  });

  it("draws a merged range once, over the cells it covers", () => {
    render(
      <Harness
        built={testSheet({ A1: "Title" }, { merges: [{ r1: "r1", r2: "r1", c1: "c1", c2: "c3" }] })}
      />,
    );
    const title = document.querySelector('[aria-rowindex="1"][aria-colindex="1"]') as HTMLElement;
    expect(title.style.width).toBe("192px");
    expect(document.querySelector('[aria-rowindex="1"][aria-colindex="2"]')).toBeNull();
  });

  it("selects by click, extends with shift and moves with the keyboard", () => {
    render(<Harness built={testSheet()} />);
    const grid = screen.getByRole("grid");
    // Each column is 64 pixels wide and each row 20 high; the content starts at 0 in jsdom.
    fireEvent.pointerDown(contentOf(), { clientX: 70, clientY: 25, button: 0 });
    expect(shown()).toBe("r2/c2-r2/c2");
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(shown()).toBe("r2/c2-r3/c2");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(shown()).toBe("r3/c3-r3/c3");
    expect(grid.getAttribute("aria-activedescendant")).toBe(
      document.querySelector('[aria-selected="true"]')!.id,
    );
  });

  it("adds ranges with Cmd held, extends the active one with Shift, and starts over on a click", () => {
    let last: SheetSelection | null = null;
    const built = testSheet();
    function Several() {
      const [selection, setSelection] = useState<SheetSelection>({
        anchor: at(1, 1),
        head: at(1, 1),
      });
      return (
        <SheetGrid
          sheet={built.sheet}
          value={built.value}
          locale={EN_US}
          selection={selection}
          onSelectionChange={(next) => {
            last = next;
            setSelection(next);
          }}
          label="Budget"
        />
      );
    }
    render(<Several />);
    const content = contentOf();
    fireEvent.pointerDown(content, { clientX: 70, clientY: 45, button: 0, metaKey: true });
    fireEvent.pointerUp(content);
    fireEvent.pointerDown(content, { clientX: 140, clientY: 65, button: 0, shiftKey: true });
    fireEvent.pointerUp(content);
    expect(last).toEqual({
      anchor: at(3, 2),
      head: at(4, 3),
      more: [{ anchor: at(1, 1), head: at(1, 1) }],
    });
    fireEvent.pointerDown(content, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerUp(content);
    expect(last).toEqual({ anchor: at(1, 1), head: at(1, 1) });
  });

  it("draws a link underlined and opens it on Cmd+click, never a script address", () => {
    const opened: string[] = [];
    const open = window.open;
    window.open = (url) => {
      opened.push(String(url));
      return null;
    };
    try {
      render(
        <Harness
          built={testSheet({
            A1: { value: "Docs", style: { link: "https://example.com/" } },
            B1: { value: "Bad", style: { link: "javascript:alert(1)" } },
          })}
        />,
      );
      expect(screen.getByText("Docs").className).toContain("underline");
      fireEvent.pointerDown(contentOf(), { clientX: 10, clientY: 5, button: 0, metaKey: true });
      fireEvent.pointerDown(contentOf(), { clientX: 70, clientY: 5, button: 0, metaKey: true });
      expect(opened).toEqual(["https://example.com/"]);
    } finally {
      window.open = open;
    }
  });

  it("jumps to the data's edges, selects its block, and whole rows and columns", () => {
    render(<Harness built={testSheet({ A1: 1, A2: 2, A3: 3, A4: 4, A7: 7, B1: "x" })} />);
    const grid = screen.getByRole("grid");
    // From A1 down: the run's end, then the next filled cell, then the sheet's last row.
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    expect(shown()).toBe("r4/c1-r4/c1");
    fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    expect(shown()).toBe("r7/c1-r7/c1");
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true, shiftKey: true });
    expect(shown()).toBe("r7/c1-r4/c1");
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(shown()).toBe("r4/c2-r1/c1");
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(shown()).toBe("r1000/c26-r1/c1");
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "C" }), { button: 0 });
    fireEvent.pointerUp(window);
    expect(shown()).toBe("r1000/c3-r1/c3");
    fireEvent.pointerDown(screen.getByRole("rowheader", { name: "2" }), { button: 0 });
    fireEvent.pointerDown(screen.getByRole("rowheader", { name: "4" }), {
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(window);
    expect(shown()).toBe("r2/c26-r4/c1");
  });

  it("keeps a selection a right-click lands in, and otherwise selects what it lands on", () => {
    render(<Harness built={testSheet({ A1: 1 })} />);
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "C" }), { button: 0 });
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "E" }), {
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(window);
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "D" }), { button: 2 });
    fireEvent.pointerUp(window);
    expect(shown()).toBe("r1000/c3-r1/c5");
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "G" }), { button: 2 });
    fireEvent.pointerUp(window);
    expect(shown()).toBe("r1000/c7-r1/c7");
    fireEvent.pointerDown(screen.getByRole("rowheader", { name: "3" }), { button: 2 });
    fireEvent.pointerUp(window);
    expect(shown()).toBe("r3/c26-r3/c1");
  });

  it("steps over hidden rows and gives them no header", () => {
    render(<Harness built={testSheet({ A3: "After" }, { rowProps: { r2: { hidden: true } } })} />);
    expect(screen.queryByRole("rowheader", { name: "2" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    expect(shown()).toBe("r3/c1-r3/c1");
  });

  it("draws conditional formats over a cell's own style, and data bars behind its text", () => {
    render(
      <Harness
        built={testSheet(
          { A1: 5, A2: 9, B1: 1, B2: 3 },
          {
            conditional: [
              {
                box: { r1: "r1", r2: "r2", c1: "c1", c2: "c1" },
                rule: {
                  kind: "compare",
                  op: "less",
                  values: [6],
                  style: { fill: "#FFC7CE", bold: true },
                },
              },
              {
                box: { r1: "r1", r2: "r2", c1: "c2", c2: "c2" },
                rule: { kind: "bar", color: "#638EC6" },
              },
            ],
          },
        )}
      />,
    );
    const first = document.querySelector<HTMLElement>('[aria-rowindex="1"][aria-colindex="1"]')!;
    expect(first.style.backgroundColor).toBe("rgb(255, 199, 206)");
    expect(first.style.fontWeight).toBe("600");
    const second = document.querySelector<HTMLElement>('[aria-rowindex="2"][aria-colindex="1"]')!;
    expect(second.style.backgroundColor).toBe("");
    const bar = document.querySelector('[aria-rowindex="2"][aria-colindex="2"]')!
      .firstElementChild as HTMLElement;
    expect(bar.style.width).toBe("calc(100% - 4px)");
  });

  it("draws frozen rows again in a pane of their own, over the scrolling cells", () => {
    render(
      <Harness
        built={testSheet({ A1: "Header", A2: "Body" }, { freeze: { row: "r1", col: null } })}
      />,
    );
    const copies = screen.getAllByText("Header");
    expect(copies).toHaveLength(2);
    // The pane's copy is only for the eye; the grid's own cell is the one named.
    expect(copies.filter((each) => each.closest("[aria-hidden]"))).toHaveLength(1);
    expect(screen.getAllByText("Body")).toHaveLength(1);
    // Its own layer, so its outlines stay under the row numbers when scrolled sideways.
    expect(copies.find((each) => each.closest("[aria-hidden]"))!.closest(".isolate")).toBeTruthy();
  });

  it("lays a drawing over the cells from its anchor, which clicks do not reach through", () => {
    render(
      <Harness
        built={testSheet()}
        overlays={[
          {
            key: "c1",
            at: at(2, 2),
            offset: { x: 10, y: 5 },
            width: 300,
            height: 200,
            label: "Sales chart",
            content: null,
          },
        ]}
      />,
    );
    const chart = screen.getByRole("figure", { name: "Sales chart" });
    expect([chart.style.top, chart.style.left, chart.style.width]).toEqual([
      "25px",
      "74px",
      "300px",
    ]);
    fireEvent.pointerDown(chart, { clientX: 100, clientY: 30, button: 0 });
    expect(shown()).toBe("r1/c1-r1/c1");
  });

  it("copies the selected cells as they show, a tab between cells and a line per row", () => {
    render(
      <Harness
        built={testSheet({
          A1: "Month",
          B1: { value: 0.25, style: { numberFormat: "0%" } },
          A2: "Jan",
          B2: 3,
        })}
      />,
    );
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(grid, { key: "ArrowRight", shiftKey: true });
    const data = new Map<string, string>();
    fireEvent.copy(grid, {
      clipboardData: { setData: (type: string, text: string) => data.set(type, text) },
    });
    expect(data.get("text/plain")).toBe("Month\t25%\nJan\t3");
  });
});

describe("scrolling to the selection", () => {
  it("leaves the scroll alone when the grid redraws without the selection moving", () => {
    const built = testSheet();
    const props = {
      sheet: built.sheet,
      value: built.value,
      locale: EN_US,
      selection: { anchor: at(80, 1), head: at(80, 1) },
      onSelectionChange: () => {},
      label: "Budget",
    };
    const { rerender } = render(<SheetGrid {...props} />);
    const grid = screen.getByRole("grid");
    expect(grid.scrollTop).toBeGreaterThan(0);
    // Scrolled back up by hand.
    grid.scrollTop = 0;
    // A parent redrawing hands over new looks with the same in them.
    rerender(<SheetGrid {...props} looks={new Map()} />);
    expect(grid.scrollTop).toBe(0);
  });
});
