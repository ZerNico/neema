import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DetailPanelContext } from "~/ui/detail-panel-context.ts";
import type { DetailPanelApi } from "~/ui/detail-panel-state.ts";
import { AttachmentPreviewDialog, type AttachmentPreviewTarget } from "./attachment-preview.tsx";

// The shell's bridge is the boundary: inside the desktop app it is a client, in a browser null.
const shell = vi.hoisted(() => ({ desktop: false }));
vi.mock("~/modules/desktop/client/bridge.ts", () => ({
  useDesktop: () => (shell.desktop ? {} : null),
}));

const image: AttachmentPreviewTarget = {
  fileName: "gear.png",
  kind: "image",
  url: "/api/files/a1",
};
const archive: AttachmentPreviewTarget = {
  fileName: "gears.zip",
  kind: "file",
  url: "/api/files/a2",
  unsupported: true,
};

function renderPreview(target: AttachmentPreviewTarget) {
  const open = vi.fn();
  const onOpenChange = vi.fn();
  const panel: DetailPanelApi = {
    open,
    refresh: vi.fn(),
    select: vi.fn(),
    closeTab: vi.fn(),
    release: vi.fn(),
    hide: vi.fn(),
    show: vi.fn(),
    newTab: vi.fn(),
    append: vi.fn(),
    replaceTab: vi.fn(),
    moveTab: vi.fn(),
  };
  render(
    <DetailPanelContext value={panel}>
      <AttachmentPreviewDialog target={target} open onOpenChange={onOpenChange} />
    </DetailPanelContext>,
  );
  return { open, onOpenChange };
}

describe("AttachmentPreviewDialog", () => {
  afterEach(() => {
    shell.desktop = false;
  });

  it("opens a previewable file in the sidebar in the desktop app", () => {
    shell.desktop = true;
    const { open, onOpenChange } = renderPreview(image);
    expect(screen.queryByRole("link", { name: "Open original" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("download")).toBe(
      "gear.png",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open in sidebar" }));
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ id: "file:/api/files/a1", title: "gear.png" }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("only downloads a file without a preview in the desktop app", () => {
    shell.desktop = true;
    renderPreview(archive);
    expect(screen.queryByRole("button", { name: "Open in sidebar" })).toBeNull();
    expect(screen.getByRole("link", { name: "Download" })).toBeTruthy();
  });

  it("links to the original in a browser", () => {
    renderPreview(image);
    expect(screen.queryByRole("button", { name: "Open in sidebar" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open original" }).getAttribute("target")).toBe(
      "_blank",
    );
  });
});
