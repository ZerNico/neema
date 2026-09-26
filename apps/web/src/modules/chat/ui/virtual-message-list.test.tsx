import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DisplayMessage } from "./message-list.tsx";
import { estimateMessageHeight } from "./estimate-message-height.ts";
import { VirtualMessageList } from "./virtual-message-list.tsx";

const mocks = vi.hoisted(() => ({
  useVirtualizer: vi.fn(),
  scrollToEnd: vi.fn(),
  scrollToOffset: vi.fn(),
  measureElement: vi.fn(),
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: mocks.useVirtualizer,
}));

vi.mock("./message-list.tsx", () => ({
  MessageBubble: () => <div />,
}));

const message = (id: string, content = "An answer.\n\nIn two paragraphs."): DisplayMessage => ({
  id,
  role: "assistant",
  content,
  reasoning: "",
  reasoningSeen: false,
  toolActivities: [],
  status: "complete",
});
const messages = [message("message-1")];
let visible: Array<{ index: number; key: string; start: number; end?: number }> = [];
/** Rows' extent; like the real virtualizer, the total adds the end padding it was given. */
let contentSize = 96;
const virtualizer = {
  getVirtualItems: () => visible,
  getTotalSize: () => contentSize + (options?.paddingEnd ?? 0),
  measureElement: mocks.measureElement,
  scrollToEnd: mocks.scrollToEnd,
  scrollToOffset: mocks.scrollToOffset,
};

type CapturedOptions = {
  anchorTo?: string;
  followOnAppend?: boolean;
  paddingEnd?: number;
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

  visible = [];
  contentSize = 96;
  mocks.scrollToEnd.mockReset();
  mocks.scrollToOffset.mockReset();
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

/** Scrolls the transcript so `distance` px remain below the view. */
const scrollTo = (distance: number) => {
  const scroller = options.getScrollElement()!;
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: 3000 },
    scrollTop: { configurable: true, value: 3000 - 800 - distance, writable: true },
  });
  fireEvent.scroll(scroller);
};

/** Eight rendered rows starting at `from`. */
const rows = (from: number) =>
  Array.from({ length: 8 }, (_, i) => ({ index: from + i, key: `m${from + i}`, start: 0 }));

describe("VirtualMessageList", () => {
  it("targets the measured end on first mount", () => {
    render(<VirtualMessageList messages={messages} />);

    expect(options.anchorTo).toBe("end");
    expect(options.followOnAppend).toBe(true);
    expect(
      typeof options.initialOffset === "function" ? options.initialOffset() : options.initialOffset,
    ).toBe(estimateMessageHeight(messages[0]!, 768));
    expect(options.scrollEndThreshold).toBe(48);
    expect(options.useAnimationFrameWithResizeObserver).toBe(false);
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
    rerender(<VirtualMessageList messages={[...messages, message("message-2")]} />);
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

  it("asks for older turns only while the rows near the start are on screen", () => {
    const many = Array.from({ length: 40 }, (_, i) => message(`m${i}`));
    const onReachStart = vi.fn();

    visible = rows(30);
    const { rerender } = render(<VirtualMessageList messages={many} onReachStart={onReachStart} />);
    expect(onReachStart).not.toHaveBeenCalled();

    visible = rows(2);
    rerender(<VirtualMessageList messages={many} onReachStart={onReachStart} />);
    expect(onReachStart).toHaveBeenCalledTimes(1);
  });

  it("says when earlier messages are loading", () => {
    render(<VirtualMessageList messages={messages} loadingOlder />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading earlier messages…");
  });

  describe("an anchored question", () => {
    // A question at 100–200 and its short answer at 200–300, in an 800px view.
    const turn = [message("earlier"), message("question"), message("answer")];
    const renderAnchored = (onReleaseAnchor = vi.fn()) => {
      visible = [
        { index: 0, key: "earlier", start: 0, end: 100 },
        { index: 1, key: "question", start: 100, end: 200 },
        { index: 2, key: "answer", start: 200, end: 300 },
      ];
      contentSize = 300;
      const view = render(<VirtualMessageList messages={turn} />);
      Object.defineProperty(options.getScrollElement()!, "clientHeight", {
        configurable: true,
        value: 800,
      });
      view.rerender(
        <VirtualMessageList
          messages={turn}
          anchorId="question"
          onReleaseAnchor={onReleaseAnchor}
        />,
      );
      return view;
    };

    it("leaves room below its answer to sit at the top of the view", () => {
      renderAnchored();
      // 800 − the scroller's 32px bottom padding − the 16px offset − 200px of turn.
      expect(options.paddingEnd).toBe(552);
    });

    it("scrolls to the top once that room is in place, and only once", () => {
      const view = renderAnchored();
      view.rerender(<VirtualMessageList messages={turn} anchorId="question" />);
      expect(mocks.scrollToOffset).toHaveBeenCalledTimes(1);
      expect(mocks.scrollToOffset).toHaveBeenCalledWith(84, { behavior: "smooth" });
    });

    it("does not follow the stream until the reader jumps to the bottom", () => {
      const onReleaseAnchor = vi.fn();
      renderAnchored(onReleaseAnchor);
      expect(options.followOnAppend).toBe(false);
      expect(options.scrollEndThreshold).toBeLessThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Jump to bottom" }));
      expect(onReleaseAnchor).toHaveBeenCalledTimes(1);
      expect(mocks.scrollToEnd).toHaveBeenLastCalledWith({ behavior: "smooth" });
    });

    it("opens on the anchored question instead of the end", () => {
      render(<VirtualMessageList messages={turn} anchorId="question" />);
      expect(mocks.scrollToEnd).not.toHaveBeenCalled();
    });

    it("follows again once the reader scrolls to the end of a long answer", () => {
      const onReleaseAnchor = vi.fn();
      visible = [
        { index: 0, key: "question", start: 0, end: 100 },
        { index: 1, key: "answer", start: 100, end: 2000 },
      ];
      const long = [message("question"), message("answer")];
      const view = render(<VirtualMessageList messages={long} />);
      Object.defineProperty(options.getScrollElement()!, "clientHeight", {
        configurable: true,
        value: 800,
      });
      view.rerender(
        <VirtualMessageList
          messages={long}
          anchorId="question"
          onReleaseAnchor={onReleaseAnchor}
        />,
      );

      scrollTo(600);
      expect(onReleaseAnchor).not.toHaveBeenCalled();
      scrollTo(20);
      expect(onReleaseAnchor).toHaveBeenCalledTimes(1);
    });

    it("stays anchored while the answer still fits below its question", () => {
      const onReleaseAnchor = vi.fn();
      renderAnchored(onReleaseAnchor);
      // The space below the answer is what the view reaches at its end.
      scrollTo(0);
      expect(onReleaseAnchor).not.toHaveBeenCalled();
    });

    it("gives up its room once the answer fills the view", () => {
      visible = [
        { index: 0, key: "question", start: 0, end: 100 },
        { index: 1, key: "answer", start: 100, end: 2000 },
      ];
      const long = [message("question"), message("answer")];
      const view = render(<VirtualMessageList messages={long} />);
      Object.defineProperty(options.getScrollElement()!, "clientHeight", {
        configurable: true,
        value: 800,
      });
      view.rerender(<VirtualMessageList messages={long} anchorId="question" />);
      expect(options.paddingEnd).toBe(0);
    });
  });
});
