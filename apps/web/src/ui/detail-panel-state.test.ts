import { describe, expect, it } from "vitest";
import {
  closeTab,
  moveTab,
  openTab,
  releaseTab,
  replaceTab,
  restoredState,
  showPanel,
  storedScope,
  tabSummary,
  type DetailPanelRequest,
  type PanelState,
} from "./detail-panel-state.ts";

const request = (id: string, extra: Partial<DetailPanelRequest> = {}): DetailPanelRequest => ({
  id,
  title: id.toUpperCase(),
  body: null,
  ...extra,
});
const empty: PanelState = { scope: "/chat/c1", tabs: [], activeId: null, visible: false };
const ids = (state: PanelState) => state.tabs.map((tab) => tab.id);
const withTabs = (...names: string[]) =>
  names.reduce((state, name) => openTab(state, request(name), true), empty);

describe("panel tabs", () => {
  it("opens beside the selected tab, or last for a new tab, and selects it", () => {
    const state = openTab(openTab(withTabs("a", "b"), request("a")), request("c"));
    expect(ids(state)).toEqual(["a", "c", "b"]);
    expect(state).toMatchObject({ activeId: "c", visible: true });
    expect(ids(openTab(state, request("d"), true))).toEqual(["a", "c", "b", "d"]);
  });

  it("selects the neighbour to the right on close, and hides with the last tab", () => {
    let state = openTab(withTabs("a", "b", "c"), request("b"));
    state = closeTab(state, "b");
    expect(state.activeId).toBe("c");
    state = closeTab(state, "c");
    expect(state.activeId).toBe("a");
    expect(closeTab(state, "a")).toMatchObject({ tabs: [], activeId: null, visible: false });
  });

  it("keeps a released restorable tab with a pending body and closes any other", () => {
    const state = openTab(withTabs("plain"), request("kept", { restorable: true }));
    const released = releaseTab(releaseTab(state, "kept"), "plain");
    expect(released.tabs).toEqual([{ id: "kept", title: "KEPT", restorable: true, request: null }]);
  });

  it("turns a tab into another in place, dropping a duplicate of the new id", () => {
    const state = replaceTab(withTabs("new", "page", "x"), "new", request("page"));
    expect(ids(state)).toEqual(["page", "x"]);
    expect(state.activeId).toBe("page");
  });

  it("moves a tab within the strip's ends", () => {
    expect(ids(moveTab(withTabs("a", "b", "c"), "a", 9))).toEqual(["b", "c", "a"]);
    expect(ids(moveTab(withTabs("a", "b", "c"), "c", -1))).toEqual(["c", "a", "b"]);
  });

  it("shows the selected tab, or a new one when there is none", () => {
    const hidden = { ...withTabs("a"), visible: false, activeId: "gone" };
    expect(showPanel(hidden, () => request("new"))).toMatchObject({ activeId: "a", visible: true });
    expect(ids(showPanel(empty, () => request("new")))).toEqual(["new"]);
  });

  it("stores restorable tabs only and restores them waiting for their owner", () => {
    const state = openTab(
      withTabs("plain"),
      request("kept", { restorable: true, data: { url: "https://a.test" } }),
    );
    const stored = storedScope(state);
    expect(stored).toEqual({
      tabs: [{ id: "kept", title: "KEPT", data: { url: "https://a.test" } }],
      activeId: "kept",
      visible: true,
    });
    expect(storedScope(withTabs("plain"))).toBeNull();
    const restored = restoredState(stored, "/chat/c1", false);
    expect(tabSummary(restored.tabs[0]!)).toEqual({
      id: "kept",
      title: "KEPT",
      data: { url: "https://a.test" },
    });
    // A phone never shows a restored panel by itself.
    expect(restoredState(stored, "/chat/c1", true).visible).toBe(false);
  });
});
