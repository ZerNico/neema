import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DE_DE, EN_US, type SheetLocale } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { parseFormula } from "@chat/sheet/model/formula";
import { NEW_SHEET, emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { CellWrite, SheetOp } from "@chat/sheet/model/ops";
import {
  SheetGrid,
  type CellEditing,
  type GridCommand,
  type OverlayChange,
  type SheetSelection,
} from "./grid.tsx";
import { dragPlace } from "./overlay-place.ts";

afterEach(cleanup);
const [NEW_ROWS, NEW_COLS] = [NEW_SHEET.rows, NEW_SHEET.cols];

const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: 1, ops }, 1).doc;
/** Row and column numbers from 1 to the IDs of a new sheet. */
const at = (row: number, col: number) => ({ r: `s1.r${row}`, c: `s1.c${col}` });
const set = (doc: SheetDoc, row: number, col: number, content: string | number): CellWrite => {
  if (typeof content === "string" && content.startsWith("=")) {
    const parsed = parseFormula(content.slice(1), { doc, sheet: "s1" });
    if (!("formula" in parsed)) throw new Error("needs growth");
    return { ...at(row, col), f: parsed.formula };
  }
  return { ...at(row, col), v: content };
};

const events: string[] = [];
const sent: GridCommand[] = [];
function Harness({ doc, locale = EN_US }: { doc: SheetDoc; locale?: SheetLocale }) {
  const [selection, setSelection] = useState<SheetSelection | null>({
    anchor: at(1, 1),
    head: at(1, 1),
  });
  const [editing, setEditing] = useState<CellEditing | null>(null);
  return (
    <div>
      <output data-testid="selection">
        {selection
          ? `${selection.anchor.r}/${selection.anchor.c}-${selection.head.r}/${selection.head.c}`
          : ""}
      </output>
      <SheetGrid
        doc={doc}
        sheet="s1"
        values={calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={locale}
        selection={selection}
        onSelectionChange={setSelection}
        label="Budget"
        editing={editing}
        onEditingChange={setEditing}
        onCommit={(cell, text) => events.push(`commit ${cell.r}/${cell.c} ${text}`)}
        editSource={() => "=A1*2"}
        onCommand={(command) => {
          events.push(command.kind);
          sent.push(command);
        }}
        onCopy={(cut) => ({ text: cut ? "cut" : "copied" })}
        onPaste={(clip) => events.push(`paste${clip.values ? " values" : ""} ${clip.text}`)}
      />
    </div>
  );
}

const cellText = (row: number, col: number) =>
  document.querySelector(`[aria-rowindex="${row}"][aria-colindex="${col}"]`)?.textContent;

describe("the sheet grid", () => {
  it("shows values as their format and locale write them, and formulas as their results", () => {
    let doc = emptyDoc();
    doc = apply(doc, {
      op: "set",
      sh: "s1",
      cells: [
        set(doc, 1, 1, 1234.5),
        set(doc, 2, 1, 2),
        set(doc, 3, 1, "=A1+A2"),
        set(doc, 1, 2, "Rent"),
      ],
    });
    doc = apply(doc, {
      op: "format",
      sh: "s1",
      area: { r1: "s1.r1", r2: "s1.r3", c1: "s1.c1", c2: "s1.c1" },
      patch: { numberFormat: "#,##0.00" },
    });
    render(<Harness doc={doc} locale={DE_DE} />);
    expect(cellText(1, 1)).toBe("1.234,50");
    expect(cellText(3, 1)).toBe("1.236,50");
    expect(cellText(1, 2)).toBe("Rent");
    expect(screen.getByRole("grid", { name: "Budget" })).toBeTruthy();
  });

  it("runs text on over empty cells only as far as it needs, its fill staying in its cell", () => {
    let doc = emptyDoc();
    const long = "A much longer label than one column holds";
    doc = apply(
      doc,
      { op: "set", sh: "s1", cells: [set(doc, 1, 1, "Short"), set(doc, 2, 1, long)] },
      {
        op: "format",
        sh: "s1",
        area: { r1: "s1.r2", r2: "s1.r2", c1: "s1.c1", c2: "s1.c1" },
        patch: { fill: "#DDEBF7" },
      },
    );
    render(<Harness doc={doc} />);
    const cell = (text: string) => screen.getByText(text).parentElement!;
    expect(cell("Short").style.width).toBe("64px");
    expect(cell("Short").nextElementSibling?.getAttribute("aria-hidden")).toBeNull();
    expect(cell(long).style.width).toBe("64px");
    // The text runs over a strip of the empty cells beside it, which keeps their bottom line.
    const spill = cell(long).previousElementSibling as HTMLElement;
    expect(Number.parseInt(spill.style.width)).toBeGreaterThanOrEqual(128);
    expect(spill.style.backgroundColor).toBe("");
  });

  it("draws a merged range once, over the cells it covers", () => {
    let doc = emptyDoc();
    doc = apply(
      doc,
      { op: "set", sh: "s1", cells: [set(doc, 1, 1, "Title")] },
      { op: "merge", sh: "s1", box: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c3" } },
    );
    render(<Harness doc={doc} />);
    const title = document.querySelector('[aria-rowindex="1"][aria-colindex="1"]') as HTMLElement;
    expect(title.style.width).toBe("192px");
    expect(document.querySelector('[aria-rowindex="1"][aria-colindex="2"]')).toBeNull();
  });

  it("selects by click, extends with shift and moves with the keyboard", () => {
    render(<Harness doc={emptyDoc()} />);
    const grid = screen.getByRole("grid");
    const content = grid.firstElementChild!.lastElementChild!;
    // Each column is 64 pixels wide and each row 20 high; the content starts at 0 in jsdom.
    fireEvent.pointerDown(content, { clientX: 70, clientY: 25, button: 0 });
    expect(screen.getByTestId("selection").textContent).toBe("s1.r2/s1.c2-s1.r2/s1.c2");
    fireEvent.keyDown(grid, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByTestId("selection").textContent).toBe("s1.r2/s1.c2-s1.r3/s1.c2");
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(screen.getByTestId("selection").textContent).toBe("s1.r3/s1.c3-s1.r3/s1.c3");
    expect(grid.getAttribute("aria-activedescendant")).toBe(
      document.querySelector('[aria-selected="true"]')!.id,
    );
  });

  it("adds ranges with Cmd held, extends the active one with Shift, and starts over on a click", () => {
    let last: SheetSelection | null = null;
    function Several() {
      const [selection, setSelection] = useState<SheetSelection | null>({
        anchor: at(1, 1),
        head: at(1, 1),
      });
      return (
        <SheetGrid
          doc={emptyDoc()}
          sheet="s1"
          values={calculateSheet(emptyDoc(), { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
          locale={EN_US}
          selection={selection}
          onSelectionChange={(next) => {
            last = next;
            setSelection(next);
          }}
          label="Budget"
          onCommit={() => {}}
        />
      );
    }
    render(<Several />);
    const content = screen.getByRole("grid").firstElementChild!.lastElementChild!;
    // Each column is 64 pixels wide and each row 20 high.
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
    let doc = emptyDoc();
    doc = apply(
      doc,
      { op: "set", sh: "s1", cells: [set(doc, 1, 1, "Docs"), set(doc, 1, 2, "Bad")] },
      {
        op: "format",
        sh: "s1",
        area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
        patch: { link: "https://example.com/" },
      },
      {
        op: "format",
        sh: "s1",
        area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c2", c2: "s1.c2" },
        patch: { link: "javascript:alert(1)" },
      },
    );
    const opened: string[] = [];
    const open = window.open;
    window.open = (url) => {
      opened.push(String(url));
      return null;
    };
    try {
      render(<Harness doc={doc} />);
      expect(screen.getByText("Docs").className).toContain("underline");
      const content = screen.getByRole("grid").firstElementChild!.lastElementChild!;
      fireEvent.pointerDown(content, { clientX: 10, clientY: 5, button: 0, metaKey: true });
      fireEvent.pointerDown(content, { clientX: 70, clientY: 5, button: 0, metaKey: true });
      expect(opened).toEqual(["https://example.com/"]);
    } finally {
      window.open = open;
    }
  });

  it("draws larger at a zoom, and reports what it changed at the stored scale", () => {
    let doc = emptyDoc();
    doc = apply(doc, { op: "set", sh: "s1", cells: [set(doc, 1, 1, "Big")] });
    const changes: OverlayChange[] = [];
    render(
      <SheetGrid
        doc={doc}
        sheet="s1"
        values={calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(1, 1), head: at(1, 1) }}
        onSelectionChange={() => {}}
        label="Budget"
        onCommit={() => {}}
        zoom={2}
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
        selectedOverlay="c1"
        onOverlaySelect={() => {}}
        onOverlayChange={(_, change) => changes.push(change)}
      />,
    );
    const cell = screen.getByText("Big").parentElement!;
    expect([cell.style.width, cell.style.height, cell.style.fontSize]).toEqual([
      "128px",
      "40px",
      "28px",
    ]);
    const chart = screen.getByRole("group", { name: "Sales chart" });
    expect([chart.style.top, chart.style.left, chart.style.width]).toEqual([
      "50px",
      "148px",
      "600px",
    ]);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(changes).toEqual([{ at: at(2, 3), offset: { x: 10, y: 5 }, width: 300, height: 200 }]);
  });

  it("draws grouped rows' outline, hides a collapsed group and reports its buttons", () => {
    const doc = apply(emptyDoc(), {
      op: "outline",
      sh: "s1",
      axis: "rows",
      list: [{ from: "s1.r2", to: "s1.r3", collapsed: true }],
    });
    const outlined: string[] = [];
    render(
      <SheetGrid
        doc={doc}
        sheet="s1"
        values={calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(1, 1), head: at(1, 1) }}
        onSelectionChange={() => {}}
        label="Budget"
        onCommit={() => {}}
        onOutline={(axis, action) =>
          outlined.push(
            `${axis} ${"level" in action ? `level ${action.level}` : action.group.start}`,
          )
        }
      />,
    );
    const headers = screen.getAllByRole("rowheader").map((each) => each.textContent);
    expect(headers.slice(0, 3)).toEqual(["1", "4", "5"]);
    fireEvent.click(screen.getByRole("button", { name: "Expand rows 2 to 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Show row outline level 2" }));
    expect(outlined).toEqual(["rows 2", "rows level 2"]);
  });

  it("jumps to the data's edges, selects its block, and whole rows and columns", () => {
    let doc = emptyDoc();
    doc = apply(doc, {
      op: "set",
      sh: "s1",
      cells: [1, 2, 3, 4, 7].map((row) => set(doc, row, 1, row)).concat(set(doc, 1, 2, "x")),
    });
    render(<Harness doc={doc} />);
    const grid = screen.getByRole("grid");
    const shown = () => screen.getByTestId("selection").textContent;
    // From A1 down: the run's end, then the next filled cell, then the sheet's last row.
    fireEvent.keyDown(grid, { key: "ArrowDown", ctrlKey: true });
    expect(shown()).toBe("s1.r4/s1.c1-s1.r4/s1.c1");
    fireEvent.keyDown(grid, { key: "ArrowDown", metaKey: true });
    expect(shown()).toBe("s1.r7/s1.c1-s1.r7/s1.c1");
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true, shiftKey: true });
    expect(shown()).toBe("s1.r7/s1.c1-s1.r4/s1.c1");
    fireEvent.keyDown(grid, { key: "ArrowUp", ctrlKey: true });
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(shown()).toBe("s1.r4/s1.c2-s1.r1/s1.c1");
    fireEvent.keyDown(grid, { key: "a", metaKey: true });
    expect(shown()).toBe(`s1.r${NEW_ROWS}/s1.c${NEW_COLS}-s1.r1/s1.c1`);
    fireEvent.keyDown(grid, { key: " ", ctrlKey: true });
    fireEvent.pointerDown(screen.getByRole("columnheader", { name: "C" }), { button: 0 });
    fireEvent.pointerUp(window);
    expect(shown()).toBe(`s1.r${NEW_ROWS}/s1.c3-s1.r1/s1.c3`);
    fireEvent.pointerDown(screen.getByRole("rowheader", { name: "2" }), { button: 0 });
    fireEvent.pointerDown(screen.getByRole("rowheader", { name: "4" }), {
      button: 0,
      shiftKey: true,
    });
    fireEvent.pointerUp(window);
    expect(shown()).toBe(`s1.r2/s1.c${NEW_COLS}-s1.r4/s1.c1`);
  });

  it("steps over hidden rows, and fits a column to its widest text on a double-click", () => {
    let doc = emptyDoc();
    doc = apply(
      doc,
      { op: "set", sh: "s1", cells: [set(doc, 3, 1, "A long label to fit")] },
      { op: "hide", sh: "s1", axis: "rows", ids: ["s1.r2"], hidden: true },
    );
    const sizes: unknown[] = [];
    render(
      <SheetGrid
        doc={doc}
        sheet="s1"
        values={calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(1, 1), head: at(1, 1) }}
        onSelectionChange={(next) => sizes.push(next.head)}
        label="Budget"
        onCommit={() => {}}
        onEditingChange={() => {}}
        onResize={(axis, id, px) => sizes.push([axis, id, px])}
      />,
    );
    expect(screen.queryByRole("rowheader", { name: "2" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    expect(sizes[0]).toEqual(at(3, 1));
    const edge = screen.getByRole("columnheader", { name: "A" }).querySelector("[aria-hidden]")!;
    fireEvent.doubleClick(edge);
    expect(sizes[1]).toEqual(["columns", "s1.c1", expect.any(Number)]);
    expect((sizes[1] as [string, string, number])[2]).toBeGreaterThan(64);
  });

  it("leaves out rows a filter hides, and draws its buttons on the header row", () => {
    const opened: string[] = [];
    render(
      <SheetGrid
        doc={emptyDoc()}
        sheet="s1"
        values={calculateSheet(emptyDoc(), { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(1, 1), head: at(1, 1) }}
        onSelectionChange={() => {}}
        label="Budget"
        hiddenRows={new Set(["s1.r3"])}
        filterButtons={{ row: "s1.r1", cols: ["s1.c1", "s1.c2"], active: new Set(["s1.c2"]) }}
        onFilterButton={(col) => opened.push(col)}
      />,
    );
    expect(screen.queryByRole("rowheader", { name: "3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filter B" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter A" }));
    expect(opened).toEqual(["s1.c1"]);
  });

  it("draws conditional formats over a cell's own style, and data bars behind its text", () => {
    let doc = emptyDoc();
    doc = apply(doc, { op: "set", sh: "s1", cells: [set(doc, 1, 1, 5), set(doc, 2, 1, 9)] });
    render(
      <SheetGrid
        doc={doc}
        sheet="s1"
        values={calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={null}
        onSelectionChange={() => {}}
        label="Budget"
        looks={
          new Map([
            ["s1.r1|s1.c1", { fill: "#FFC7CE", bold: true }],
            ["s1.r2|s1.c1", { bar: { fraction: 0.5, color: "#638EC6" } }],
          ])
        }
      />,
    );
    const first = document.querySelector<HTMLElement>('[aria-rowindex="1"][aria-colindex="1"]')!;
    expect(first.style.backgroundColor).toBe("rgb(255, 199, 206)");
    expect(first.style.fontWeight).toBe("600");
    const second = document.querySelector('[aria-rowindex="2"][aria-colindex="1"]')!;
    const bar = second.firstElementChild as HTMLElement;
    expect(bar.style.width).toBe("calc(50% - 4px)");
  });

  it("types a fresh value, edits the formula behind one, and sends commands up", () => {
    events.length = 0;
    render(<Harness doc={emptyDoc()} />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "4" });
    const input = screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement;
    expect(input.value).toBe("4");
    // The caret follows the character typed to begin, so the next one lands after it.
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 1]);
    fireEvent.change(input, { target: { value: "42" } });
    // Alt+Enter breaks the line at the caret instead of committing.
    input.setSelectionRange(1, 1);
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(input.value).toBe("4\n2");
    fireEvent.change(input, { target: { value: "42" } });
    // A fresh value commits on an arrow key, and the selection moves on.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(events).toEqual(["commit s1.r1/s1.c1 42"]);
    expect(screen.getByTestId("selection").textContent).toBe("s1.r2/s1.c1-s1.r2/s1.c1");
    fireEvent.keyDown(grid, { key: "F2" });
    const editor = screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("=A1*2");
    expect(editor.selectionStart).toBe(5);
    // Editing an existing value, arrows move the caret; Escape drops the edit.
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Cell content" })).toBeNull();
    fireEvent.keyDown(grid, { key: "Delete" });
    fireEvent.keyDown(grid, { key: "z", metaKey: true });
    fireEvent.keyDown(grid, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(grid, { key: "d", ctrlKey: true });
    expect(events.slice(1)).toEqual(["clear", "undo", "redo", "fill"]);
    const clip = (text: string) => ({
      clipboardData: { getData: (type: string) => (type === "text/plain" ? text : "") },
    });
    fireEvent.paste(grid, clip("a"));
    // Cmd+Shift+V pastes values only, as in Google Sheets.
    fireEvent.keyDown(grid, { key: "V", metaKey: true, shiftKey: true });
    fireEvent.paste(grid, clip("b"));
    expect(events.slice(5)).toEqual(["paste a", "paste values b"]);
    fireEvent.keyDown(grid, { key: "k", metaKey: true });
    expect(events.at(-1)).toBe("link");
    // Ctrl+; starts typing today's date, as Excel does.
    fireEvent.keyDown(grid, { key: ";", ctrlKey: true });
    const stamped = screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement;
    expect(stamped.value).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("knows Excel's shortcuts for formats, hiding, sheets, sums and the cell above", () => {
    sent.length = 0;
    const doc = apply(emptyDoc(), { op: "set", sh: "s1", cells: [set(emptyDoc(), 1, 1, 12.5)] });
    render(<Harness doc={doc} />);
    const grid = screen.getByRole("grid");
    const press = (key: string, extra: Record<string, unknown> = {}) =>
      fireEvent.keyDown(grid, { key, ctrlKey: true, ...extra });
    press("$", { shiftKey: true, code: "Digit4" });
    press("&", { shiftKey: true, code: "Digit7" });
    press("9", { code: "Digit9" });
    press(")", { shiftKey: true, code: "Digit0" });
    press("PageDown", { code: "PageDown" });
    fireEvent.keyDown(grid, { key: "F11", shiftKey: true });
    fireEvent.keyDown(grid, { key: "F2", shiftKey: true });
    fireEvent.keyDown(grid, { key: "≠", altKey: true, code: "Equal" });
    // Ctrl+Minus deletes only whole rows or columns: for a cell it does nothing.
    press("-", { code: "Minus" });
    expect(sent).toEqual([
      { kind: "numberFormat", format: "currency" },
      { kind: "borders", border: "outer" },
      { kind: "hide", axis: "rows", hidden: true },
      { kind: "hide", axis: "columns", hidden: false },
      { kind: "sheet", step: 1 },
      { kind: "newSheet" },
      { kind: "comment" },
      { kind: "autosum" },
    ]);
    // With the whole row selected, Ctrl+Minus deletes it.
    fireEvent.keyDown(grid, { key: " ", shiftKey: true });
    press("-", { code: "Minus" });
    expect(sent.at(-1)).toEqual({ kind: "delete", axis: "rows" });
    // Ctrl+' starts typing the formula above, Ctrl+Shift+" the value it shows.
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    press("'", { code: "Quote" });
    const input = screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement;
    expect(input.value).toBe("=A1*2");
    fireEvent.keyDown(input, { key: "Escape" });
    press('"', { shiftKey: true, code: "Quote" });
    expect(
      (screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement).value,
    ).toBe("12.5");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Cell content" }), { key: "Escape" });
    // Backspace empties the cell to type afresh; Escape leaves it as it was.
    fireEvent.keyDown(grid, { key: "Backspace" });
    expect(
      (screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("completes functions, points at cells for references, and cycles $ with F4", () => {
    events.length = 0;
    render(<Harness doc={emptyDoc()} />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "=" });
    const input = screen.getByRole("textbox", { name: "Cell content" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "=su", selectionStart: 3 } });
    expect(screen.getByRole("listbox", { name: "Functions" }).textContent).toContain("SUMIF");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("=SUM(");
    expect(screen.getByText("number1")).toBeTruthy();
    // Arrows now point at cells instead of ending the edit, starting from the edited one.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("=SUM(A3");
    // A click on a cell replaces the reference pointing wrote, and keeps the edit going.
    const content = grid.firstElementChild!.lastElementChild!;
    fireEvent.pointerDown(content, { clientX: 70, clientY: 45, button: 0 });
    fireEvent.pointerUp(content);
    expect(input.value).toBe("=SUM(B3");
    fireEvent.keyDown(input, { key: "F4" });
    expect(input.value).toBe("=SUM($B$3");
    expect(events).toEqual([]);
  });

  it("draws frozen rows again in a pane of their own, over the scrolling cells", () => {
    let doc = emptyDoc();
    doc = apply(
      doc,
      { op: "set", sh: "s1", cells: [set(doc, 1, 1, "Header"), set(doc, 2, 1, "Body")] },
      { op: "freeze", sh: "s1", row: "s1.r1", col: null },
    );
    render(<Harness doc={doc} />);
    const copies = screen.getAllByText("Header");
    expect(copies).toHaveLength(2);
    // The pane's copy is only for the eye; the grid's own cell is the one named.
    expect(copies.filter((each) => each.closest("[aria-hidden]"))).toHaveLength(1);
    expect(screen.getAllByText("Body")).toHaveLength(1);
    // Its own layer, so its outlines stay under the row numbers when scrolled sideways.
    expect(copies.find((each) => each.closest("[aria-hidden]"))!.closest(".isolate")).toBeTruthy();
  });

  it("selects a chart over the cells, nudges it a cell at a time and drops a drag where it lands", () => {
    const changes: Array<[string, OverlayChange]> = [];
    const commands: string[] = [];
    function Charted() {
      const [selected, setSelected] = useState<string | null>(null);
      return (
        <SheetGrid
          doc={emptyDoc()}
          sheet="s1"
          values={calculateSheet(emptyDoc(), { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
          locale={EN_US}
          selection={{ anchor: at(1, 1), head: at(1, 1) }}
          onSelectionChange={() => {}}
          label="Budget"
          onCommit={() => {}}
          overlays={[
            {
              key: "c1",
              at: at(2, 2),
              width: 300,
              height: 200,
              label: "Sales chart",
              content: <button type="button">Legend</button>,
            },
          ]}
          selectedOverlay={selected}
          onOverlaySelect={setSelected}
          onOverlayChange={(key, change) => changes.push([key, change])}
          onOverlayCommand={(key, command) => commands.push(`${key} ${command}`)}
        />
      );
    }
    render(<Charted />);
    const chart = screen.getByRole("group", { name: "Sales chart" });
    fireEvent.pointerDown(chart, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(chart.getAttribute("aria-selected")).toBe("true");
    expect(chart.querySelectorAll("[data-handle]")).toHaveLength(8);
    fireEvent.keyDown(chart, { key: "ArrowRight" });
    fireEvent.keyDown(chart, { key: "d", metaKey: true });
    fireEvent.keyDown(chart, { key: "Delete" });
    expect(changes).toEqual([
      ["c1", { at: at(2, 3), offset: { x: 0, y: 0 }, width: 300, height: 200 }],
    ]);
    expect(commands).toEqual(["c1 duplicate", "c1 delete"]);
    // A drag lands where it was dropped: the cell under the corner, and how far into it.
    fireEvent.pointerDown(chart, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10 + 64 * 2 + 5, clientY: 10 + 20 * 3 + 2 });
    fireEvent.pointerUp(window);
    expect(changes[1]).toEqual([
      "c1",
      { at: at(5, 4), offset: { x: 5, y: 2 }, width: 300, height: 200 },
    ]);
    fireEvent.keyDown(chart, { key: "Escape" });
    expect(chart.getAttribute("aria-selected")).toBe("false");
  });
});

describe("the grid's fill handle", () => {
  it("reports how far a drag went past the selection, and a double-click", () => {
    const fills: unknown[] = [];
    render(
      <SheetGrid
        doc={emptyDoc()}
        sheet="s1"
        values={calculateSheet(emptyDoc(), { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(1, 1), head: at(2, 1) }}
        onSelectionChange={() => {}}
        label="Budget"
        onCommit={() => {}}
        onFill={(fill) => fills.push(fill)}
      />,
    );
    const handle = document.querySelector("[data-fill-handle]")!;
    fireEvent.pointerDown(handle, { button: 0, clientX: 60, clientY: 40 });
    // jsdom lays nothing out, so the content box sits at 0,0: row 6 is 100 to 120 px down.
    fireEvent.pointerMove(window, { clientX: 30, clientY: 110 });
    fireEvent.pointerUp(window, { ctrlKey: true });
    fireEvent.doubleClick(handle);
    // Back over the selection's own last row: that row is to be cleared.
    fireEvent.pointerDown(handle, { button: 0, clientX: 60, clientY: 40 });
    fireEvent.pointerMove(window, { clientX: 30, clientY: 10 });
    fireEvent.pointerUp(window);
    expect(fills).toEqual([
      { direction: "down", count: 4, mode: "alternate" },
      { direction: "down", count: "auto", mode: "auto" },
      { direction: "down", count: -1, mode: "auto" },
    ]);
  });
});

describe("dragging the selection's border", () => {
  it("reports the cells it moved by, and copying with Alt held", () => {
    const drags: unknown[] = [];
    render(
      <SheetGrid
        doc={emptyDoc()}
        sheet="s1"
        values={calculateSheet(emptyDoc(), { revision: 1, epoch: 0, now: 45_000, seed: 1 })}
        locale={EN_US}
        selection={{ anchor: at(2, 2), head: at(3, 3) }}
        onSelectionChange={() => {}}
        label="Budget"
        onCommit={() => {}}
        onDragSelection={(shift, copy) => drags.push([shift, copy])}
      />,
    );
    const edge = document.querySelector('[data-move-edge="top"]')!;
    fireEvent.pointerDown(edge, { button: 0, clientX: 70, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 70 + 64 * 2, clientY: 20 + 20 * 3 });
    fireEvent.pointerUp(window, { altKey: true });
    fireEvent.pointerDown(edge, { button: 0, clientX: 70, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window);
    expect(drags).toEqual([
      [{ rows: 3, cols: 2 }, true],
      [{ rows: -1, cols: -1 }, false],
    ]);
  });
});

describe("dragging an overlay's handles", () => {
  const place = { top: 100, left: 100, width: 200, height: 100 };
  const min = { width: 50, height: 50 };
  it("grows from the far side, never below its least size, and keeps proportions with shift", () => {
    expect(dragPlace(place, { handle: "nw", dx: -20, dy: -10, ratio: false }, min)).toEqual({
      top: 90,
      left: 80,
      width: 220,
      height: 110,
    });
    expect(dragPlace(place, { handle: "e", dx: -400, dy: 0, ratio: false }, min).width).toBe(50);
    expect(dragPlace(place, { handle: "se", dx: 200, dy: 0, ratio: true }, min)).toMatchObject({
      width: 400,
      height: 200,
    });
  });
});
