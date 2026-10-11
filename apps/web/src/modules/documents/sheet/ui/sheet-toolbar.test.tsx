import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetToolbar, type ToolbarCommand } from "./sheet-toolbar.tsx";

afterEach(cleanup);

describe("the sheet's toolbar", () => {
  it("formats, borders and totals the selection, previewing number formats on the cell", async () => {
    const commands: ToolbarCommand[] = [];
    render(
      <SheetToolbar
        style={{ bold: true }}
        canUndo={false}
        canRedo={false}
        readOnly={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onCommand={(command) => commands.push(command)}
        zoom={1}
        preview={(code) => (code === "0.00%" ? "12.50%" : "0.125")}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    fireEvent.click(screen.getByRole("button", { name: "Borders" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Outside borders" }));
    fireEvent.click(screen.getByRole("button", { name: "Number format" }));
    expect((await screen.findByRole("menuitem", { name: /Percentage/ })).textContent).toContain(
      "12.50%",
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Percentage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Increase decimal" }));
    expect(commands).toEqual([
      { kind: "format", patch: { bold: null } },
      { kind: "format", patch: { underline: true } },
      { kind: "borders", border: "outer", line: { style: "thin" } },
      { kind: "format", patch: { numberFormat: "0.00%" } },
      { kind: "decimals", delta: 1 },
    ]);
  });

  it("draws borders in the line and colour picked, and Excel's thick and double ones", async () => {
    const commands: ToolbarCommand[] = [];
    render(
      <SheetToolbar
        style={{}}
        canUndo={false}
        canRedo={false}
        readOnly={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onCommand={(command) => commands.push(command)}
        zoom={1}
        preview={() => ""}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Borders" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Line style" }));
    // The menu stays open while its line and colour are picked, as Excel's does.
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dashed" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Line colour" }));
    fireEvent.click(await screen.findByRole("button", { name: "#C00000" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Bottom border" }));
    fireEvent.click(screen.getByRole("button", { name: "Borders" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Bottom double border" }));
    expect(commands).toEqual([
      { kind: "borders", border: "bottom", line: { style: "dashed", color: "#C00000" } },
      { kind: "borders", border: "bottom", line: { style: "double", color: "#C00000" } },
    ]);
  });

  it("keeps Excel's commands on their tabs, each a button of its own", async () => {
    const commands: ToolbarCommand[] = [];
    render(
      <SheetToolbar
        style={{}}
        canUndo={false}
        canRedo={false}
        readOnly={false}
        onUndo={() => {}}
        onRedo={() => {}}
        onCommand={(command) => commands.push(command)}
        zoom={1}
        preview={() => ""}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    fireEvent.click(screen.getByRole("tab", { name: "Insert" }));
    fireEvent.click(await screen.findByRole("button", { name: "Line chart" }));
    fireEvent.click(screen.getByRole("button", { name: "More charts" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Waterfall" }));
    fireEvent.click(screen.getByRole("tab", { name: "Data" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sort Z to A" }));
    fireEvent.click(screen.getByRole("button", { name: "Group" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide and unhide" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unhide columns" }));
    fireEvent.click(screen.getByRole("tab", { name: "View" }));
    fireEvent.click(await screen.findByRole("button", { name: "Zoom in" }));
    expect(commands).toEqual([
      { kind: "find" },
      { kind: "chart", chart: "line" },
      { kind: "chart", chart: "waterfall" },
      { kind: "sortOrder", descending: true },
      { kind: "outline", group: true },
      { kind: "hide", axis: "columns", hidden: false },
      { kind: "zoom", zoom: 1.1 },
    ]);
  });
});
