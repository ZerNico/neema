import { describe, expect, it } from "vitest";
import { FREEZE_AFTER_MS, LIVE_TAB_CAP, planLifecycle, type LifecycleTab } from "./lifecycle.ts";

const now = 10 * FREEZE_AFTER_MS;
const tab = (id: string, patch: Partial<LifecycleTab> = {}): LifecycleTab => ({
  id,
  owner: "other",
  live: true,
  lastShownAt: now,
  audible: false,
  ...patch,
});
const context = { now, visible: new Set<string>(), onScreen: null, held: new Set<string>() };

describe("planLifecycle", () => {
  it("runs the shown tab, throttles hidden ones and freezes the long unseen", () => {
    const plan = planLifecycle(
      [tab("shown"), tab("recent", { lastShownAt: now - 1000 }), tab("old", { lastShownAt: 0 })],
      { ...context, visible: new Set(["shown"]) },
    );
    expect(Object.fromEntries(plan)).toEqual({
      shown: "active",
      recent: "background",
      old: "frozen",
    });
  });

  it("keeps the chat on screen, a held chat and a playing page from freezing", () => {
    const plan = planLifecycle(
      [
        tab("screen", { owner: "c1", lastShownAt: 0 }),
        tab("held", { owner: "c2", lastShownAt: 0 }),
        tab("heldGone", { owner: "c2", live: false }),
        tab("audio", { lastShownAt: 0, audible: true }),
      ],
      { ...context, onScreen: "c1", held: new Set(["c2"]) },
    );
    expect(Object.fromEntries(plan)).toEqual({
      screen: "background",
      held: "active",
      heldGone: "discarded",
      audio: "background",
    });
  });

  it("leaves a discarded tab discarded until it is shown", () => {
    const tabs = [tab("gone", { live: false })];
    expect(planLifecycle(tabs, context).get("gone")).toBe("discarded");
    expect(planLifecycle(tabs, { ...context, visible: new Set(["gone"]) }).get("gone")).toBe(
      "active",
    );
  });

  it("discards the least recently shown beyond the cap, never a protected tab", () => {
    const tabs = Array.from({ length: LIVE_TAB_CAP + 3 }, (_, index) =>
      tab(`t${index}`, { lastShownAt: now - index }),
    );
    // The two oldest are protected, so the next three oldest go instead.
    const last = tabs.length - 1;
    tabs[last] = tab(`t${last}`, { lastShownAt: 0, audible: true });
    tabs[last - 1] = tab(`t${last - 1}`, { lastShownAt: 1, owner: "screen" });
    const plan = planLifecycle(tabs, { ...context, onScreen: "screen" });
    const discarded = [...plan].filter(([, state]) => state === "discarded").map(([id]) => id);
    expect(discarded.toSorted()).toEqual(
      [`t${last - 2}`, `t${last - 3}`, `t${last - 4}`].toSorted(),
    );
    expect([...plan.values()].filter((state) => state !== "discarded")).toHaveLength(LIVE_TAB_CAP);
  });
});
