import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteLinkClick, setLinkOpener } from "./link-opener.ts";
import { LINK_SAFETY } from "./link-safety.tsx";

const show = (onClose = vi.fn()) =>
  render(
    <>
      {LINK_SAFETY.renderModal?.({
        isOpen: true,
        onClose,
        onConfirm: vi.fn(),
        url: "https://evil.test/login",
      })}
    </>,
  );

afterEach(() => setLinkOpener(null));

describe("link safety", () => {
  it("asks with the app's own dialog, showing the real address", () => {
    show();
    expect(screen.getByRole("dialog")).toHaveTextContent("Open external link?");
    expect(screen.getByText("This opens evil.test in your browser.")).toBeInTheDocument();
    expect(screen.getByText("https://evil.test/login")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open link" })).toBeInTheDocument();
  });

  it("does the other with ⌘ or Ctrl: asks to leave when the panel is the default, and back", () => {
    const opener = vi.fn();
    setLinkOpener({ open: opener, byDefault: true });
    noteLinkClick(true);
    const first = show();
    expect(screen.getByRole("dialog")).toHaveTextContent("Open external link?");
    expect(opener).not.toHaveBeenCalled();
    first.unmount();

    setLinkOpener({ open: opener, byDefault: false });
    noteLinkClick(true);
    show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveBeenCalledWith("https://evil.test/login");
    noteLinkClick(false);
  });

  it("cancels on Escape or a click outside, since opening a link destroys nothing", async () => {
    const onClose = vi.fn();
    show(onClose);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens in the side panel without asking when links go there", () => {
    const opener = vi.fn();
    const onClose = vi.fn();
    setLinkOpener({ open: opener, byDefault: true });
    show(onClose);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveBeenCalledWith("https://evil.test/login");
    expect(onClose).toHaveBeenCalled();
  });
});
