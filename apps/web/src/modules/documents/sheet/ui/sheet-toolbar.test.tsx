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
});
