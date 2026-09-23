import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
import { SidebarProvider, useSidebar } from "./primitives/sidebar";
import { ClosesOnLink } from "./sidebar-links.tsx";

function SidebarState() {
  const sidebar = useSidebar();
  return (
    <>
      <button type="button" onClick={() => sidebar.setOpenMobile(true)}>
        Open sheet
      </button>
      <output aria-label="Sidebar">
        {sidebar.state} {sidebar.openMobile ? "sheet open" : "sheet closed"}
      </output>
    </>
  );
}

const sidebarState = () => screen.getByRole("status", { name: "Sidebar" });

function renderSidebar() {
  render(
    <SidebarProvider>
      <ClosesOnLink>
        <a href="#agents">Agents</a>
        <button type="button">Rename</button>
        <DropdownMenu>
          <DropdownMenuTrigger>Account</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem render={<a href="#settings" />}>Settings</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </ClosesOnLink>
      <SidebarState />
    </SidebarProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open sheet" }));
  expect(sidebarState()).toHaveTextContent("expanded sheet open");
  return sidebarState;
}

describe("ClosesOnLink", () => {
  it("closes the mobile sheet on a link and leaves the docked sidebar expanded", () => {
    const state = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(state()).toHaveTextContent("expanded sheet open");
    fireEvent.click(screen.getByRole("link", { name: "Agents" }));
    expect(state()).toHaveTextContent("expanded sheet closed");
  });

  it("counts a link in a menu portalled out of the sidebar", async () => {
    const state = renderSidebar();
    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Settings" }));
    expect(state()).toHaveTextContent("expanded sheet closed");
  });

  it("stays open for a link opened in a new tab", () => {
    const state = renderSidebar();
    fireEvent.click(screen.getByRole("link", { name: "Agents" }), { metaKey: true });
    expect(state()).toHaveTextContent("expanded sheet open");
  });
});
