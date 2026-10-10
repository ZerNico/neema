import { fireEvent, render, screen } from "@testing-library/react";
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
const controllerOf = (doc: SheetDoc, comments: SheetState["comments"] = []): SheetController => {
  const state: SheetState = {
    doc,
    revision: 1,
    moment: { now: 45_000, seed: 1 },
    status: "live",
    comments,
    presence: new Map(),
    refused: null,
    pending: 0,
    canUndo: false,
    canRedo: false,
  };
  return {
    documentId: "sheet-1",
    subscribe: () => () => {},
    getState: () => state,
    sync: () => null,
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
      return (
        <SheetPanelBody
          controller={{
            documentId: "sheet-1",
            subscribe: sync.subscribe,
            getState: sync.getState,
            sync: () => sync,
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

  it("lays a picture over the cells, and deletes it from the keyboard", () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const sync = new SheetSync({
      documentId: "sheet-1",
      clientId: "me",
      connect: () => ({
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {},
      }),
      push: () => new Promise(() => {}),
    });
    const doc = apply(emptyDoc(), {
      op: "imagePut",
      id: "p1",
      image: {
        sheet: "s1",
        at: { r: "s1.r2", c: "s1.c2" },
        size: { width: 120, height: 60 },
        src: "data:image/png;base64,iVBORw0KGgo=",
        alt: "Logo",
      },
    });
    listeners.get("reset")!(
      new MessageEvent("reset", {
        data: JSON.stringify({
          type: "reset",
          doc,
          revision: 1,
          moment: { now: 45_000, seed: 1 },
          acked: null,
        }),
      }),
    );
    render(
      <SheetPanelBody
        controller={{
          documentId: "sheet-1",
          subscribe: sync.subscribe,
          getState: sync.getState,
          sync: () => sync,
          flush: async () => true,
          unpersisted: () => false,
          selected: () => [],
        }}
        canEdit
        toolbarSlot={null}
      />,
    );
    const picture = screen.getByRole("group", { name: "Picture: Logo" });
    expect(picture.querySelector("img")?.getAttribute("alt")).toBe("Logo");
    fireEvent.pointerDown(picture, { button: 0, clientX: 5, clientY: 5 });
    fireEvent.pointerUp(window);
    fireEvent.keyDown(picture, { key: "Delete" });
    expect(screen.queryByRole("group", { name: "Picture: Logo" })).toBeNull();
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

  it("shows the thread on the selected cell", () => {
    const doc = apply(emptyDoc(), {
      op: "anchor",
      thread: "t1",
      at: { sh: "s1", r: "s1.r1", c: "s1.c1" },
    });
    const root = {
      id: "t1",
      threadId: "t1",
      author: { id: "u1", name: "Ada" },
      byAssistant: false,
      fromFile: null,
      body: "Check this total",
      createdAt: new Date(0).toISOString(),
      resolvedAt: null,
      quote: "A1",
      toAssistant: false,
      answered: false,
    };
    render(
      <SheetPanelBody controller={controllerOf(doc, [root])} canEdit={false} toolbarSlot={null} />,
    );
    expect(screen.getByText("Check this total")).toBeTruthy();
  });

  it("opens a thread on a range from any of its cells, and lists every thread", async () => {
    const doc = apply(emptyDoc(), {
      op: "anchor",
      thread: "t1",
      at: { sh: "s1", r: "s1.r2", c: "s1.c1", r2: "s1.r3", c2: "s1.c2" },
    });
    const root = {
      id: "t1",
      threadId: "t1",
      author: { id: "u1", name: "Ada" },
      byAssistant: false,
      fromFile: null,
      body: "These two rows look off",
      createdAt: new Date(0).toISOString(),
      resolvedAt: null,
      quote: "A2:B3",
      toAssistant: false,
      answered: false,
    };
    const slot = document.createElement("div");
    document.body.append(slot);
    render(
      <SheetPanelBody controller={controllerOf(doc, [root])} canEdit={false} toolbarSlot={slot} />,
    );
    expect(screen.queryByText("These two rows look off")).toBeNull();
    // B3, the range's far corner, is 2 columns in and 3 rows down.
    const grid = screen.getByRole("grid", { name: "Sheet1" });
    const content = grid.firstElementChild!.lastElementChild!;
    fireEvent.pointerDown(content, { clientX: 70, clientY: 45, button: 0 });
    fireEvent.pointerUp(content);
    expect(await screen.findByText("These two rows look off")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All comments" }));
    expect((await screen.findByText("A2:B3")).textContent).toBe("A2:B3");
    slot.remove();
  });

  it("draws a sheet's charts over its cells", () => {
    const box = { r1: "s1.r1", r2: "s1.r2", c1: "s1.c2", c2: "s1.c2" };
    const doc = apply(
      emptyDoc(),
      {
        op: "set",
        sh: "s1",
        cells: [
          { r: "s1.r1", c: "s1.c1", v: "Jan" },
          { r: "s1.r2", c: "s1.c1", v: "Feb" },
          { r: "s1.r1", c: "s1.c2", v: 10 },
          { r: "s1.r2", c: "s1.c2", v: 30 },
        ],
      },
      {
        op: "chartPut",
        id: "c1",
        chart: {
          sheet: "s1",
          kind: "column",
          title: { text: "Sales by month" },
          at: { r: "s1.r4", c: "s1.c1" },
          size: { width: 400, height: 240 },
          series: [
            {
              name: { text: "Sales" },
              values: box,
              categories: { ...box, c1: "s1.c1", c2: "s1.c1" },
            },
          ],
        },
      },
      {
        op: "chartPut",
        id: "c2",
        chart: {
          sheet: "s1",
          kind: "pie",
          title: { text: "Share" },
          legend: "right",
          at: { r: "s1.r20", c: "s1.c1" },
          size: { width: 300, height: 200 },
          series: [{ values: box, categories: { ...box, c1: "s1.c1", c2: "s1.c1" } }],
        },
      },
    );
    render(<SheetPanelBody controller={controllerOf(doc)} canEdit={false} toolbarSlot={null} />);
    expect(screen.getByText("Sales by month")).toBeTruthy();
    const pie = screen.getByRole("img", { name: "Share" });
    expect(pie.querySelectorAll("path")).toHaveLength(2);
    expect(screen.getAllByText("Feb").length).toBeGreaterThan(1);
  });

  it("charts the selected cells from the ribbon's Insert tab", async () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const sync = new SheetSync({
      documentId: "sheet-1",
      clientId: "me",
      connect: () => ({
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {},
      }),
      push: () => new Promise(() => {}),
    });
    const doc = apply(emptyDoc(), {
      op: "set",
      sh: "s1",
      cells: [
        { r: "s1.r1", c: "s1.c1", v: "Month" },
        { r: "s1.r1", c: "s1.c2", v: "Sales" },
        { r: "s1.r2", c: "s1.c1", v: "Jan" },
        { r: "s1.r2", c: "s1.c2", v: 10 },
      ],
    });
    listeners.get("reset")!(
      new MessageEvent("reset", {
        data: JSON.stringify({
          type: "reset",
          doc,
          revision: 1,
          moment: { now: 45_000, seed: 1 },
          acked: null,
        }),
      }),
    );
    const slot = document.createElement("div");
    document.body.append(slot);
    function Live() {
      return (
        <SheetPanelBody
          controller={{
            documentId: "sheet-1",
            subscribe: sync.subscribe,
            getState: sync.getState,
            sync: () => sync,
            flush: async () => true,
            unpersisted: () => false,
            selected: () => [],
          }}
          canEdit
          toolbarSlot={slot}
        />
      );
    }
    render(<Live />);
    const content = screen.getByRole("grid").firstElementChild!.lastElementChild!;
    fireEvent.pointerDown(content, { clientX: 5, clientY: 5, button: 0 });
    fireEvent.pointerDown(content, { clientX: 70, clientY: 25, button: 0, shiftKey: true });
    // Charts are on the ribbon's Insert tab, as in Excel.
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Insert chart" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Column" }));
    expect(Object.values(sync.getState().doc!.charts)).toMatchObject([
      { kind: "column", series: [{ name: { cell: { r: "s1.r1", c: "s1.c2" } } }] },
    ]);
    sync.destroy();
    slot.remove();
  });

  it("refuses what a cell's validation does not allow, and picks from its list", async () => {
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const sync = new SheetSync({
      documentId: "sheet-1",
      clientId: "me",
      connect: () => ({
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => {},
      }),
      push: () => new Promise(() => {}),
    });
    const doc = apply(emptyDoc(), {
      op: "validations",
      sh: "s1",
      list: [
        {
          id: "v1",
          box: { r1: "s1.r1", r2: "s1.r9", c1: "s1.c1", c2: "s1.c1" },
          rule: { kind: "list", values: ["Open", "Done"] },
          onError: "stop",
          allowBlank: true,
        },
      ],
    });
    listeners.get("reset")!(
      new MessageEvent("reset", {
        data: JSON.stringify({
          type: "reset",
          doc,
          revision: 1,
          moment: { now: 45_000, seed: 1 },
          acked: null,
        }),
      }),
    );
    function Live() {
      return (
        <SheetPanelBody
          controller={{
            documentId: "sheet-1",
            subscribe: sync.subscribe,
            getState: sync.getState,
            sync: () => sync,
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
    const cell = () => sync.getState().doc!.sheet.s1!.cells["s1.r1"]?.["s1.c1"]?.v;
    fireEvent.keyDown(grid, { key: "M" });
    const input = screen.getByRole("textbox", { name: "Cell content" });
    fireEvent.change(input, { target: { value: "Maybe" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cell()).toBeUndefined();
    // Back on A1, the list opens with Alt+Down and Enter picks its first choice.
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    fireEvent.keyDown(grid, { key: "ArrowDown", altKey: true });
    expect(screen.getByRole("listbox", { name: "Choices" }).textContent).toBe("OpenDone");
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "Enter" });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(cell()).toBe("Done");
    sync.destroy();
  });
});
