import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveText, nextSmoothStep } from "./live-text.ts";

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

describe("createLiveText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const empty = { text: "", reasoning: "", reasoningSeen: false, lastSeq: 0 };
  const watched = (initial = empty) => {
    const live = createLiveText(initial);
    const notify = vi.fn();
    const unsubscribe = live.subscribe(notify);
    return { live, notify, unsubscribe, shown: () => live.getSnapshot().text };
  };

  it("shows the initial text at once, since history never animates", () => {
    const { live } = watched({ ...empty, text: "already streamed text" });
    expect(live.getSnapshot()).toMatchObject({ text: "already streamed text", drained: true });
  });

  it("reveals a large chunk word by word over the following ticks", () => {
    const { live, shown } = watched();

    // One big provider chunk lands at once.
    live.append("text", "The whole sentence arrives in a single delta");
    expect(shown()).toBe("");
    expect(live.getSnapshot().drained).toBe(false);

    vi.advanceTimersByTime(30);
    expect(shown()).toBe("The");
    vi.advanceTimersByTime(30);
    expect(shown()).toBe("The whole");

    // …and the full text is reached without any input ever being dropped.
    vi.advanceTimersByTime(30 * 10);
    expect(live.getSnapshot()).toMatchObject({
      text: "The whole sentence arrives in a single delta",
      rawTextLength: "The whole sentence arrives in a single delta".length,
      drained: true,
    });
  });

  it("publishes growth on the tick, not on every received chunk", () => {
    const { live, notify } = watched();
    live.append("text", "one ");
    // Leaving the drained state is published at once; later growth waits.
    expect(notify).toHaveBeenCalledTimes(1);
    live.append("text", "two ");
    live.append("text", "three");
    expect(notify).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("stops ticking once caught up and while nobody watches", () => {
    const { live, notify, unsubscribe } = watched();
    live.append("text", "short");
    vi.advanceTimersByTime(30 * 5);
    const settled = notify.mock.calls.length;
    vi.advanceTimersByTime(30 * 5);
    expect(notify).toHaveBeenCalledTimes(settled);

    unsubscribe();
    live.append("text", " more words");
    vi.advanceTimersByTime(30 * 5);
    expect(live.getSnapshot().text).toBe("short");
  });

  it("paces reasoning separately and marks it seen even when hidden", () => {
    const { live } = watched();
    live.append("reasoning", "");
    expect(live.getSnapshot()).toMatchObject({ reasoningSeen: true, drained: true });
    live.append("reasoning", "Thinking it over");
    vi.advanceTimersByTime(30);
    expect(live.getSnapshot().reasoning).toBe("Thinking");
  });

  it("claims each sequence number once, across chunk kinds", () => {
    const live = createLiveText({ ...empty, lastSeq: 3 });
    expect(live.claim(3)).toBe(false);
    expect(live.claim(4)).toBe(true);
    expect(live.claim(4)).toBe(false);
    expect(live.lastSeq).toBe(4);
  });
});
