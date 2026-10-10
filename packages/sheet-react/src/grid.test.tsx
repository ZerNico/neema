import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DE_DE, EN_US, type SheetLocale } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { CellWrite, SheetOp } from "@chat/sheet/model/ops";
import { SheetGrid, type CellEditing, type SheetSelection } from "./grid.tsx";

afterEach(cleanup);

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
        onCommand={(command) => events.push(command.kind)}
        onCopy={(cut) => (cut ? "cut" : "copied")}
        onPaste={(text) => events.push(`paste ${text}`)}
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

  it("types a fresh value, edits the formula behind one, and sends commands up", () => {
    events.length = 0;
    render(<Harness doc={emptyDoc()} />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "4" });
    const input = screen.getByRole("textbox", { name: "Cell content" }) as HTMLInputElement;
    expect(input.value).toBe("4");
    fireEvent.change(input, { target: { value: "42" } });
    // A fresh value commits on an arrow key, and the selection moves on.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(events).toEqual(["commit s1.r1/s1.c1 42"]);
    expect(screen.getByTestId("selection").textContent).toBe("s1.r2/s1.c1-s1.r2/s1.c1");
    fireEvent.keyDown(grid, { key: "F2" });
    const editor = screen.getByRole("textbox", { name: "Cell content" }) as HTMLInputElement;
    expect(editor.value).toBe("=A1*2");
    // Editing an existing value, arrows move the caret; Escape drops the edit.
    fireEvent.keyDown(editor, { key: "ArrowLeft" });
    fireEvent.keyDown(editor, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Cell content" })).toBeNull();
    fireEvent.keyDown(grid, { key: "Delete" });
    fireEvent.keyDown(grid, { key: "z", metaKey: true });
    fireEvent.keyDown(grid, { key: "z", metaKey: true, shiftKey: true });
    fireEvent.keyDown(grid, { key: "d", ctrlKey: true });
    expect(events.slice(1)).toEqual(["clear", "undo", "redo", "fill"]);
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
  });
});
