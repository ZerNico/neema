import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppMotionProvider, MotionSwap } from "./motion.tsx";

let reduced = false;
const listeners = new Set<() => void>();
beforeEach(() => {
  reduced = false;
  listeners.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return reduced;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
      addListener: () => {},
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const swap = (
  value: string,
  text: string | null = value,
  kind: "text" | "rolling-text" = "text",
) => (
  <StrictMode>
    <AppMotionProvider>
      <button>
        <MotionSwap value={value} kind={kind}>
          {text}
        </MotionSwap>
      </button>
    </AppMotionProvider>
  </StrictMode>
);

describe("MotionSwap", () => {
  it("starts settled and does not replay an unchanged value", () => {
    const { rerender, container } = render(swap("First"));
    const current = screen.getByText("First");
    expect(current.style.opacity).toBe("1");
    expect(current.style.transform).toBe("none");
    rerender(swap("First", "Updated metadata"));
    expect(screen.getByText("Updated metadata")).toBe(current);
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("shows the latest value immediately with at most one inaccessible outgoing copy", async () => {
    const { rerender, container } = render(swap("First"));
    rerender(swap("Second"));
    rerender(swap("Third"));
    expect(screen.getByRole("button", { name: "Third" })).toBeInTheDocument();
    expect(screen.queryByText("First")).toBeNull();
    expect(container.querySelectorAll("[inert]")).toHaveLength(1);
    const outgoing = screen.getByText("Second").closest("[inert]");
    expect(outgoing).toHaveAttribute("aria-hidden", "true");
    expect(outgoing).toHaveClass("pointer-events-none", "absolute");
    await waitFor(() => expect(container.querySelector("[inert]")).toBeNull());
    expect(screen.getByRole("button", { name: "Third" })).toBeInTheDocument();
  });

  it.each(["text", "rolling-text"] as const)(
    "settles an active %s swap when reduced motion changes",
    (kind) => {
      const { rerender, container } = render(swap("First", "First", kind));
      rerender(swap("Second", "Second", kind));
      act(() => {
        reduced = true;
        listeners.forEach((listener) => listener());
      });
      expect(container.querySelector("[inert]")).toBeNull();
      rerender(swap("Third", "Third", kind));
      expect(container.querySelector("[inert]")).toBeNull();
      expect(screen.getByText("Third").style.transform).toBe("none");
    },
  );

  it("handles absent content without retaining extra ghosts", async () => {
    const { rerender, container } = render(swap("", null));
    rerender(swap("Appeared"));
    expect(screen.getByText("Appeared")).toBeInTheDocument();
    expect(container.querySelector("[inert]")).toBeNull();
    rerender(swap("", null));
    expect(screen.getByText("Appeared").closest("[inert]")).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("Appeared")).toBeNull());
  });
});
