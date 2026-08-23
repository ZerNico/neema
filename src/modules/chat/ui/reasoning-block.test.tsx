import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";
import { ReasoningBlock } from "./reasoning-block.tsx";

const toggle = () => screen.getByRole("button", { name: /Thinking|Thought process/ });
// Matched on assembled text, not a single node: while reasoning is active the
// animation plugin splits the markdown into per-word spans.
const paneShown = () => (document.body.textContent ?? "").includes("Chain of thought…");

describe("ReasoningBlock", () => {
  it("shows only a pulse indicator for hidden reasoning while active", () => {
    const { container, rerender } = render(<ReasoningBlock reasoning="" active />);
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();

    rerender(<ReasoningBlock reasoning="" active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("auto-expands while thinking and collapses when the answer starts", () => {
    const { rerender } = render(<ReasoningBlock reasoning="Chain of thought…" active />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(paneShown()).toBe(true);

    rerender(<ReasoningBlock reasoning="Chain of thought…" active={false} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(paneShown()).toBe(false);
  });

  it("lets a manual collapse stick while still thinking", () => {
    const { rerender } = render(<ReasoningBlock reasoning="Chain of thought…" active />);
    act(() => toggle().click());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    // More reasoning streams in — the user's choice holds.
    rerender(<ReasoningBlock reasoning="Chain of thought… and more" active />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
  });

  it("collapses on finish even after a manual expand, then reopens on request", () => {
    const { rerender } = render(<ReasoningBlock reasoning="Chain of thought…" active />);
    act(() => toggle().click());
    act(() => toggle().click());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");

    // Finishing wins over the manual expand made during streaming.
    rerender(<ReasoningBlock reasoning="Chain of thought…" active={false} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    // A manual expand of the finished summary sticks.
    act(() => toggle().click());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(paneShown()).toBe(true);
  });

  it("re-arms the automatic behavior for the next generation", () => {
    const { rerender } = render(<ReasoningBlock reasoning="First thoughts" active={false} />);
    act(() => toggle().click());
    act(() => toggle().click());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");

    // A retry starts thinking again — the stale manual collapse must not
    // keep the fresh reasoning hidden.
    rerender(<ReasoningBlock reasoning="First thoughts" active />);
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });
});
