import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "./message-list.tsx";
import { VirtualMessageList } from "./virtual-message-list.tsx";

const mocks = vi.hoisted(() => ({
  useVirtualizer: vi.fn(),
  scrollToEnd: vi.fn(),
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: mocks.useVirtualizer,
}));

vi.mock("./message-list.tsx", () => ({
  MessageBubble: () => <div />,
}));

const messages = [{ id: "message-1" }] as DisplayMessage[];
const virtualizer = {
  getVirtualItems: () => [],
  getTotalSize: () => 96,
  measureElement: mocks.measureElement,
  scrollToEnd: mocks.scrollToEnd,
};

type CapturedOptions = {
  anchorTo?: string;
  followOnAppend?: boolean;
  initialOffset?: number | (() => number);
  scrollEndThreshold?: number;
  useAnimationFrameWithResizeObserver?: boolean;
  getScrollElement: () => HTMLDivElement | null;
};

let options: CapturedOptions;
let rawScrollTo: ReturnType<typeof vi.fn>;
const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  rawScrollTo = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: rawScrollTo,
  });

  mocks.scrollToEnd.mockReset();
  mocks.measureElement.mockReset();
  mocks.useVirtualizer.mockReset();
  mocks.useVirtualizer.mockImplementation((nextOptions: CapturedOptions) => {
    options = nextOptions;
    return virtualizer;
  });
});

afterEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

describe("VirtualMessageList", () => {
  it("targets the measured end on first mount", () => {
    render(<VirtualMessageList messages={messages} />);

    expect(options.anchorTo).toBe("end");
    expect(options.followOnAppend).toBe(true);
    expect(
      typeof options.initialOffset === "function" ? options.initialOffset() : options.initialOffset,
    ).toBe(96);
    expect(options.scrollEndThreshold).toBe(48);
    expect(options.useAnimationFrameWithResizeObserver).toBe(true);
    expect(options.getScrollElement()).toHaveClass("overflow-y-auto");
    expect(options.getScrollElement()).toHaveClass("[overflow-anchor:none]");
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(mocks.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
    expect(rawScrollTo).not.toHaveBeenCalled();
  });

  it("leaves following and size anchoring to the virtualizer", () => {
    const { rerender } = render(<VirtualMessageList messages={messages} />);

    // Its default anchoring corrects first measurements above the fold and
    // holds still while the reader scrolls up.
    expect(virtualizer).not.toHaveProperty("shouldAdjustScrollPositionOnItemSizeChange");

    // New rows are followed by `followOnAppend`, not by this component.
    rerender(
      <VirtualMessageList messages={[...messages, { id: "message-2" } as DisplayMessage]} />,
    );
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps the floating jump button opaque on hover in both themes", () => {
    render(<VirtualMessageList messages={messages} />);

    const button = screen.getByRole("button", { name: "Jump to bottom" });
    expect(button).toHaveClass("bg-popover", "text-popover-foreground", "hover:bg-muted");
    expect(button).not.toHaveClass("dark:bg-transparent");
    expect(button).not.toHaveClass("dark:hover:bg-input/30");
  });

  it("shows the jump button once scrolled up and reattaches from it", () => {
    render(<VirtualMessageList messages={messages} />);
    const scroller = options.getScrollElement()!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });

    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toHaveClass("opacity-100");
    expect(screen.getByRole("button", { name: "Jump to bottom" })).not.toHaveAttribute("inert");

    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(2);
    expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toHaveClass("opacity-0");
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toHaveAttribute("inert");
  });
});
