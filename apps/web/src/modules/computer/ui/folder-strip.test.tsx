import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComposerFolders } from "../client/use-composer-folders.ts";
import { FolderStrip } from "./folder-strip.tsx";

const folders = (items: ComposerFolders["items"]): ComposerFolders => ({
  items,
  onAdd: vi.fn(),
  onChooseAgain: vi.fn(),
  onRemove: vi.fn(),
  busy: false,
});

describe("FolderStrip", () => {
  it("shows nothing until a folder is attached", () => {
    const { container } = render(<FolderStrip folders={folders([])} disabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists the chat's folders and detaches one from its menu", async () => {
    const value = folders([
      { name: "site", readOnly: false, alive: true },
      { name: "refs", readOnly: true, alive: true },
    ]);
    render(<FolderStrip folders={value} disabled={false} />);
    expect(screen.getByRole("button", { name: /refs\s?· read-only/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "site" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Detach site" }));
    expect(value.onRemove).toHaveBeenCalledWith("site");
  });

  it("offers to pick a moved folder again", async () => {
    const value = folders([{ name: "site", readOnly: false, alive: false }]);
    render(<FolderStrip folders={value} disabled={false} />);
    const trigger = screen.getByRole("button", { name: "site" });
    expect(trigger).toHaveAttribute("title", "This folder is no longer where it was.");
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Choose it again" }));
    expect(value.onChooseAgain).toHaveBeenCalledWith("site");
  });
});
