import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ToolPermissions } from "./tool-permissions.tsx";

const pressed = (tool: string) =>
  within(screen.getByRole("group", { name: `${tool} permission` }))
    .getAllByRole("button")
    .filter((button) => button.getAttribute("aria-pressed") === "true")
    .map((button) => button.getAttribute("aria-label"));

describe("tool permissions", () => {
  it("shows reads allowed and changes needing approval when nothing is saved", () => {
    render(<ToolPermissions kind="outline" permissions={{}} onChange={() => {}} />);
    expect(pressed("Search documents")).toEqual(["Always allow"]);
    expect(pressed("Create documents")).toEqual(["Needs approval"]);
    expect(screen.getByRole("combobox", { name: "Read-only tools permission" })).toHaveTextContent(
      "Always allow",
    );
  });

  it("reads Custom once one tool in a group differs", () => {
    render(
      <ToolPermissions
        kind="outline"
        permissions={{ create_document: "allow" }}
        onChange={() => {}}
      />,
    );
    expect(
      screen.getByRole("combobox", { name: "Write and delete tools permission" }),
    ).toHaveTextContent("Custom");
  });

  it("changes just the one tool clicked", () => {
    const onChange = vi.fn();
    render(<ToolPermissions kind="outline" permissions={{}} onChange={onChange} />);
    fireEvent.click(
      within(screen.getByRole("group", { name: "Update documents permission" })).getByRole(
        "button",
        { name: "Blocked" },
      ),
    );
    expect(onChange).toHaveBeenCalledWith({ update_document: "block" });
  });
});
