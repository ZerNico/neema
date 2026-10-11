import { describe, expect, it } from "vitest";
import { stepZoom } from "./zoom.ts";

describe("sheet zoom", () => {
  it("steps in and out through Excel's stops, from wherever a pinch left it", () => {
    expect([stepZoom(1, 1), stepZoom(1, -1)]).toEqual([1.1, 0.9]);
    expect([stepZoom(1.17, 1), stepZoom(1.17, -1)]).toEqual([1.25, 1.1]);
    expect([stepZoom(2, 1), stepZoom(0.5, -1)]).toEqual([2, 0.5]);
  });
});
