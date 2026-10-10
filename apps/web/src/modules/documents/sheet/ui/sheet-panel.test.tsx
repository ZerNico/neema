import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import type { SheetController } from "../client/use-sheet.ts";
import type { SheetState } from "../client/sheet-sync.ts";
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
  };
  return {
    documentId: "sheet-1",
    sync: null,
    state,
    flush: async () => true,
    unpersisted: () => false,
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
    render(<SheetPanelBody controller={controllerOf(doc)} />);
    const answer = document.querySelector('[aria-rowindex="2"][aria-colindex="1"]')!;
    expect(answer.textContent).toBe("42");
    const grid = screen.getByRole("grid", { name: "Sheet1" });
    const content = grid.firstElementChild!.lastElementChild!;
    fireEvent.pointerDown(content, { clientX: 5, clientY: 25, button: 0 });
    expect(screen.getByText("A2")).toBeTruthy();
    expect(screen.getByText("=A1*2")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(screen.getByRole("grid", { name: "Notes" })).toBeTruthy();
  });
});
