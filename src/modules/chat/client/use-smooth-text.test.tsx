import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextSmoothStep, useSmoothText } from "./use-smooth-text.ts";

describe("nextSmoothStep", () => {
  it("releases one word per step, leading whitespace attached", () => {
    const target = "Hello brave new world";
    let shown = "";
    const steps: string[] = [];
    while (shown !== target) {
      shown = nextSmoothStep(shown, target);
      steps.push(shown);
    }
    expect(steps).toEqual(["Hello", "Hello brave", "Hello brave new", "Hello brave new world"]);
  });

  it("keeps markdown line breaks glued to the word that follows them", () => {
    expect(nextSmoothStep("First paragraph.", "First paragraph.\n\nSecond one")).toBe(
      "First paragraph.\n\nSecond",
    );
  });

  it("flushes a whitespace-only tail instead of holding it back", () => {
    expect(nextSmoothStep("Done.", "Done.\n\n")).toBe("Done.\n\n");
  });

  it("does nothing when the display is caught up", () => {
    expect(nextSmoothStep("same", "same")).toBe("same");
  });

  it("snaps to a target that is not an extension of what is shown", () => {
    expect(nextSmoothStep("old answer text", "new one")).toBe("new one");
  });

  it("releases proportionally more per step under a large backlog", () => {
    const target = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const after = nextSmoothStep("", target);
    // 100 words pending → 10 words this tick, not 1: the display is not
    // allowed to drift a minute behind a fast provider.
    expect(after.split(" ")).toHaveLength(10);
    expect(target.startsWith(after)).toBe(true);
  });
});

describe("useSmoothText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the initial text at once — history never animates", () => {
    const { result } = renderHook(() => useSmoothText("already streamed text"));
    expect(result.current).toBe("already streamed text");
  });

  it("reveals a large chunk word by word over the following ticks", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: string }) => useSmoothText(target),
      {
        initialProps: { target: "" },
      },
    );

    // One big provider chunk lands at once.
    rerender({ target: "The whole sentence arrives in a single delta" });
    expect(result.current).toBe("");

    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("The");
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("The whole");

    // …and the full text is reached without any input ever being dropped.
    act(() => vi.advanceTimersByTime(30 * 10));
    expect(result.current).toBe("The whole sentence arrives in a single delta");
  });

  it("keeps pacing the tail after the stream ends — no closing pop", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: string }) => useSmoothText(target),
      {
        initialProps: { target: "" },
      },
    );
    // The provider's final chunk and its `done` arrive back to back; the
    // target has stopped growing but the backlog still lands as words.
    rerender({ target: "Last chunk then silence" });
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("Last");
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("Last chunk");
    act(() => vi.advanceTimersByTime(30 * 5));
    expect(result.current).toBe("Last chunk then silence");
  });

  it("never flashes the previous generation when a new one starts", () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: string }) => useSmoothText(target),
      {
        initialProps: { target: "old generation tail" },
      },
    );

    // Retry: the stream resets to empty and goes live again.
    rerender({ target: "" });
    expect(result.current).toBe("");

    rerender({ target: "Fresh " });
    act(() => vi.advanceTimersByTime(30));
    expect(result.current).toBe("Fresh");
  });
});
