import { describe, expect, it } from "vitest";
import {
  DETAIL_PANEL_MIN,
  clampDetailPanelWidth,
  defaultDetailPanelWidth,
} from "./detail-panel-width.ts";

describe("detail panel width", () => {
  it("grows past half a wide window, leaving the sidebar and a readable chat", () => {
    expect(clampDetailPanelWidth(2_000, 1_728)).toBe(1_088);
    expect(clampDetailPanelWidth(900, 1_728)).toBe(900);
  });

  it("never goes below its minimum, even in a narrow window", () => {
    expect(clampDetailPanelWidth(100, 1_728)).toBe(DETAIL_PANEL_MIN);
    expect(clampDetailPanelWidth(2_000, 800)).toBe(DETAIL_PANEL_MIN);
  });

  it("opens at its usual share until someone drags it", () => {
    expect(defaultDetailPanelWidth(1_728)).toBe(657);
  });
});
