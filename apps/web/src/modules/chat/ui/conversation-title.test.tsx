import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationTitle,
  createTitleRevealRegistry,
  type TitleRevealRegistry,
} from "./conversation-title.tsx";

const TITLE = "Postgres vs SQLite";

// Hand-driven rAF: the reveal is time-based, so the test has to own the clock.
let frames: Array<FrameRequestCallback> = [];
let resizeObservers: Array<() => void> = [];
let now = 0;

const advance = (ms: number) => {
  now += ms;
  const due = frames;
  frames = [];
  act(() => {
    for (const frame of due) frame(now);
  });
};

const resize = () => {
  act(() => {
    for (const notify of resizeObservers) notify();
  });
};

const reducedMotion = (matches: boolean) => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
};

beforeEach(() => {
  frames = [];
  resizeObservers = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class ResizeObserverMock implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeObservers.push(() => callback([], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const renderTitle = (
  title: string | null,
  registry: TitleRevealRegistry = createTitleRevealRegistry(),
  createdAt?: Date | string | number,
) => {
  const props = createdAt === undefined ? {} : { createdAt };
  const view = render(
    <ConversationTitle conversationId="conv-1" title={title} registry={registry} {...props} />,
  );
  const rerender = (next: string | null) =>
    view.rerender(
      <ConversationTitle conversationId="conv-1" title={next} registry={registry} {...props} />,
    );
  return { ...view, rerender, registry };
};

const node = () => document.querySelector<HTMLElement>("[data-title-state]")!;
const textNode = () => document.querySelector<HTMLElement>("[data-title-text]")!;

const makeOverflow = (viewportWidth = 100, textWidth = 220) => {
  Object.defineProperty(node(), "clientWidth", { configurable: true, value: viewportWidth });
  Object.defineProperty(textNode(), "scrollWidth", { configurable: true, value: textWidth });
  resize();
};

describe("ConversationTitle", () => {
  it("shows a labelled placeholder while the title is being generated", () => {
    renderTitle(null);
    expect(node()).toHaveAttribute("data-title-state", "pending");
    expect(screen.getByLabelText("Generating title")).toBeInTheDocument();
  });

  it("renders a title that was already there without animating", () => {
    renderTitle(TITLE);
    expect(node()).toHaveAttribute("data-title-state", "ready");
    expect(node()).toHaveTextContent(TITLE);
    expect(frames).toHaveLength(0);
  });

  it("fades and scrolls only the overflowing sidebar title", () => {
    renderTitle(TITLE, createTitleRevealRegistry(), "2026-08-22T12:00:00Z");

    expect(node()).not.toHaveClass("truncate");
    expect(node()).not.toHaveAttribute("data-title-overflowing");

    makeOverflow();
    expect(node()).toHaveAttribute("data-title-overflowing", "true");
    // The right-edge fade itself is unassertable here: jsdom drops any
    // linear-gradient carrying a calc() stop, so the mask never reaches the
    // CSSOM. data-title-overflowing and data-title-scrolling gate the same
    // branch that picks between the one- and two-edge gradients.

    fireEvent.pointerEnter(node());
    expect(node()).toHaveAttribute("data-title-scrolling", "true");
    expect(textNode().style.transform).toBe("translateX(-132px)");
    expect(textNode().style.transitionDuration).toBe("4125ms");

    fireEvent.pointerLeave(node());
    expect(node()).not.toHaveAttribute("data-title-scrolling");
    expect(textNode().style.transform).toBe("translateX(0)");
    expect(textNode().style.transitionDuration).toBe("180ms");
  });

  it("does not move an overflowing title when reduced motion is preferred", () => {
    reducedMotion(true);
    renderTitle(TITLE, createTitleRevealRegistry(), "2026-08-22T12:00:00Z");
    makeOverflow();

    fireEvent.pointerEnter(node());
    expect(node()).not.toHaveAttribute("data-title-scrolling");
    expect(textNode().style.transform).toBe("translateX(0)");
  });

  it("shows every sidebar title and its creation age in an arrowless preview", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-22T14:00:00Z"));
    renderTitle(TITLE, createTitleRevealRegistry(), "2026-08-22T12:00:00Z");

    expect(node()).not.toHaveAttribute("data-title-overflowing");
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    fireEvent.focus(node());

    const tooltip = document.querySelector<HTMLElement>('[data-slot="tooltip-content"]')!;
    expect(tooltip).toBeInTheDocument();
    expect(tooltip.parentElement).toHaveAttribute("data-side", "right");
    expect(within(tooltip).getByText(TITLE)).toBeInTheDocument();
    expect(within(tooltip).getByText("Created 2 hours ago")).toBeInTheDocument();
    expect(tooltip.querySelector('[data-slot="tooltip-arrow"]')).toBeNull();
  });

  it("types the title in when generation resolves", () => {
    const { rerender } = renderTitle(null);
    rerender(TITLE);

    // Nothing of the title has been painted yet, so there is no flash of the full text.
    expect(node()).toHaveAttribute("data-title-state", "revealing");
    expect(node()).toHaveTextContent("");
    expect(node()).toHaveAttribute("aria-label", TITLE);

    advance(0);
    advance(300);
    const partial = node().textContent ?? "";
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(TITLE.length);
    expect(TITLE.startsWith(partial)).toBe(true);

    advance(300);
    expect(node()).toHaveAttribute("data-title-state", "ready");
    expect(node()).toHaveTextContent(TITLE);
  });

  it("does not replay the reveal for a conversation that already played it", () => {
    const registry = createTitleRevealRegistry();
    const first = renderTitle(null, registry);
    first.rerender(TITLE);
    advance(0);
    advance(600);
    first.unmount();

    renderTitle(TITLE, registry);
    expect(node()).toHaveAttribute("data-title-state", "ready");
    expect(frames).toHaveLength(0);
  });

  it("skips the animation when the user prefers reduced motion", () => {
    reducedMotion(true);
    const { rerender } = renderTitle(null);
    rerender(TITLE);
    expect(node()).toHaveAttribute("data-title-state", "ready");
    expect(node()).toHaveTextContent(TITLE);
    expect(frames).toHaveLength(0);
  });

  it("does not animate a rename", () => {
    const { rerender } = renderTitle(TITLE);
    rerender("Renamed by hand");
    expect(node()).toHaveAttribute("data-title-state", "ready");
    expect(node()).toHaveTextContent("Renamed by hand");
    expect(frames).toHaveLength(0);
  });
});
