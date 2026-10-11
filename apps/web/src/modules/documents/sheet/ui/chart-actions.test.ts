import { describe, expect, it } from "vitest";
import { emptyDoc } from "@chat/sheet/model";
import type { Chart } from "@chat/sheet/model/chart";
import { chartActions, chartDecorations, duplicateChart } from "./chart-actions.ts";

const box = (r1: number, c1: number, r2: number, c2: number) => ({
  r1: `s1.r${r1}`,
  r2: `s1.r${r2}`,
  c1: `s1.c${c1}`,
  c2: `s1.c${c2}`,
});
const chart: Chart = {
  sheet: "s1",
  at: { r: "s1.r2", c: "s1.c5" },
  size: { width: 400, height: 260 },
  kind: "column",
  series: [
    {
      values: box(2, 2, 4, 2),
      categories: box(2, 1, 4, 1),
      name: { cell: { sh: "s1", r: "s1.r1", c: "s1.c2" } },
    },
    { sheet: "s2", values: box(2, 3, 4, 3) },
  ],
};

describe("a selected chart on the grid", () => {
  it("outlines the ranges it draws from on this sheet only", () => {
    expect(chartDecorations(chart, "s1").map((each) => [each.key, each.selection])).toEqual([
      ["chart-values:0", { anchor: { r: "s1.r2", c: "s1.c2" }, head: { r: "s1.r4", c: "s1.c2" } }],
      ["chart-labels:0", { anchor: { r: "s1.r2", c: "s1.c1" }, head: { r: "s1.r4", c: "s1.c1" } }],
      ["chart-name:0", { anchor: { r: "s1.r1", c: "s1.c2" }, head: { r: "s1.r1", c: "s1.c2" } }],
    ]);
  });

  it("duplicates a row and a column on, and offers only images to a reader", () => {
    expect(duplicateChart(emptyDoc(), chart, "copy")).toMatchObject({
      op: "chartPut",
      id: "copy",
      chart: { at: { r: "s1.r3", c: "s1.c6" }, size: chart.size },
    });
    expect(chartActions(true).map((each) => each.action)).toEqual(["png", "svg", "copy"]);
  });
});
