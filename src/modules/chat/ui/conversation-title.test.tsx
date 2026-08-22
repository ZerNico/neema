import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConversationTitle,
  createTitleRevealRegistry,
  type TitleRevealRegistry,
} from "./conversation-title.tsx";

const TITLE = "Postgres vs SQLite";

// Hand-driven rAF: the reveal is time-based, so the test has to own the clock.
let frames: Array<FrameRequestCallback> = [];
let now = 0;

const advance = (ms: number) => {
  now += ms;
  const due = frames;
  frames = [];
  act(() => {
    for (const frame of due) frame(now);
  });
};

const reducedMotion = (matches: boolean) => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches })),
  );
};

beforeEach(() => {
  frames = [];
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => vi.unstubAllGlobals());

const renderTitle = (
  title: string | null,
  registry: TitleRevealRegistry = createTitleRevealRegistry(),
) => {
  const view = render(
    <ConversationTitle conversationId="conv-1" title={title} registry={registry} />,
  );
  const rerender = (next: string | null) =>
    view.rerender(<ConversationTitle conversationId="conv-1" title={next} registry={registry} />);
  return { ...view, rerender, registry };
};

const node = () => document.querySelector("[data-title-state]")!;

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

  it("types the title in when generation resolves", () => {
    const { rerender } = renderTitle(null);
    rerender(TITLE);

    // Nothing of the title has been painted yet — no flash of the full text.
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
