import { fireEvent, render, screen } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { SheetController } from "../client/use-sheet.ts";
import { SheetSync, type SheetState } from "../client/sheet-sync.ts";
import SheetPanelBody from "./sheet-panel.tsx";

const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: 1, ops }, 1).doc;
const controllerOf = (doc: SheetDoc): SheetController => {
  const state: SheetState = {
    doc,
    revision: 1,
    moment: { now: 45_000, seed: 1 },
    status: "live",
    comments: [],
    presence: new Map(),
    refused: null,
    pending: 0,
    canUndo: false,
    canRedo: false,
  };
  return {
    documentId: "sheet-1",
    sync: null,
    state,
    flush: async () => true,
    unpersisted: () => false,
    selected: () => [],
  };
};

describe("an open sheet", () => {
  it("shows calculated cells, the selected cell's formula and every sheet's tab", () => {
    let doc = emptyDoc();
    const formula = parseFormula("A1*2", { doc, sheet: "s1" });
    if (!("formula" in formula)) throw new Error("needs growth");
    doc = apply(
      doc,
      {
        op: "set",
        sh: "s1",
        cells: [
          { r: "s1.r1", c: "s1.c1", v: 21 },
          { r: "s1.r2", c: "s1.c1", f: formula.formula },
        ],
      },
      { op: "sheetAdd", id: "s2", name: "Notes", after: "s1", rows: ["n1"], cols: ["m1"] },
    );
    render(<SheetPanelBody controller={controllerOf(doc)} canEdit={false} toolbarSlot={null} />);
    const answer = document.querySelector('[aria-rowindex="2"][aria-colindex="1"]')!;
    expect(answer.textContent).toBe("42");
    const grid = screen.getByRole("grid", { name: "Sheet1" });
    const content = grid.firstElementChild!.lastElementChild!;
    fireEvent.pointerDown(content, { clientX: 5, clientY: 25, button: 0 });
    expect(screen.getByText("A2")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Formula bar" })).toHaveProperty("value", "=A1*2");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("grid", { name: "Notes" })).toBeTruthy();
  });

  it("writes what is typed, calculates it and takes it back on undo", () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const sync = new SheetSync({
      documentId: "sheet-1",
      clientId: "me",
      connect: () => ({
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {},
      }),
      // Never answers, as if the network were slow: the edit shows regardless.
      push: () => new Promise(() => {}),
    });
    listeners.get("reset")!(
      new MessageEvent("reset", {
        data: JSON.stringify({
          type: "reset",
          doc: emptyDoc(),
          revision: 0,
          moment: { now: 45_000, seed: 1 },
          acked: null,
        }),
      }),
    );
    function Live() {
      const state = useSyncExternalStore(sync.subscribe, sync.getState);
      return (
        <SheetPanelBody
          controller={{
            documentId: "sheet-1",
            sync,
            state,
            flush: async () => true,
            unpersisted: () => false,
            selected: () => [],
          }}
          canEdit
          toolbarSlot={null}
        />
      );
    }
    render(<Live />);
    const grid = screen.getByRole("grid");
    fireEvent.keyDown(grid, { key: "=" });
    const editor = screen.getByRole("textbox", { name: "Cell content" });
    fireEvent.change(editor, { target: { value: "=1+2" } });
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(document.querySelector('[aria-rowindex="1"][aria-colindex="1"]')!.textContent).toBe("3");
    fireEvent.keyDown(grid, { key: "z", metaKey: true });
    expect(document.querySelector('[aria-rowindex="1"][aria-colindex="1"]')!.textContent).toBe("");
    sync.destroy();
  });

  it("finds cells by what they show or their formula, and moves to each", () => {
    const doc = apply(emptyDoc(), {
      op: "set",
      sh: "s1",
      cells: [
        { r: "s1.r1", c: "s1.c1", v: "Rent" },
        { r: "s1.r3", c: "s1.c2", v: "rent paid" },
        { r: "s1.r2", c: "s1.c1", v: "Food" },
      ],
    });
    render(<SheetPanelBody controller={controllerOf(doc)} canEdit={false} toolbarSlot={null} />);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "f", metaKey: true });
    const find = screen.getByRole("textbox", { name: "Find in sheet" });
    fireEvent.change(find, { target: { value: "rent" } });
    expect(screen.getByText("1 of 2")).toBeTruthy();
    fireEvent.keyDown(find, { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeTruthy();
    expect(screen.getByText("B3")).toBeTruthy();
  });
});
