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

const messages = [{ id: "message-1" }] as unknown as DisplayMessage[];
const virtualizer = {
  getVirtualItems: () => [],
  getTotalSize: () => 96,
  measureElement: mocks.measureElement,
  scrollToEnd: mocks.scrollToEnd,
};

type CapturedOptions = {
  anchorTo?: string;
  initialOffset?: number | (() => number);
  scrollEndThreshold?: number;
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
    render(<VirtualMessageList messages={messages} followKey={0} />);

    expect(options.anchorTo).toBe("end");
    expect(
      typeof options.initialOffset === "function" ? options.initialOffset() : options.initialOffset,
    ).toBe(96);
    expect(options.scrollEndThreshold).toBe(48);
    expect(options.getScrollElement()).toHaveClass("overflow-y-auto");
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(mocks.scrollToEnd).toHaveBeenCalledWith({ behavior: "auto" });
    expect(rawScrollTo).not.toHaveBeenCalled();
  });

  it("follows streamed growth while pinned", () => {
    const { rerender } = render(<VirtualMessageList messages={messages} followKey={0} />);

    rerender(<VirtualMessageList messages={messages} followKey={1} />);

    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(2);
    expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "auto" });
  });

  it("detaches on user scroll and reattaches from the jump button", () => {
    const { rerender } = render(<VirtualMessageList messages={messages} followKey={0} />);
    const scroller = options.getScrollElement()!;
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });

    fireEvent.scroll(scroller);
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toHaveClass("opacity-100");

    rerender(<VirtualMessageList messages={messages} followKey={1} />);
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(2);
    expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "smooth" });
    expect(screen.getByRole("button", { name: "Jump to bottom" })).toHaveClass("opacity-0");

    rerender(<VirtualMessageList messages={messages} followKey={2} />);
    expect(mocks.scrollToEnd).toHaveBeenCalledTimes(3);
    expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "auto" });
  });
});
