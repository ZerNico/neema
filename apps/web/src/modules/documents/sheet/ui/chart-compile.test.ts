import { createChartScene, renderChartSvg } from "@tanstack/charts";
import { describe, expect, it } from "vitest";
import { EN_US } from "@chat/sheet/locales";
import type { Chart, ChartData, ChartSeries } from "@chat/sheet/model/chart";
import { compileChart } from "./chart-compile.ts";

const box = { r1: "a", r2: "b", c1: "c", c2: "d" };
const chartOf = (
  kind: Chart["kind"],
  series: Partial<ChartSeries>[],
  more: Partial<Chart> = {},
): Chart => ({
  sheet: "s1",
  at: { r: "a", c: "c" },
  size: { width: 480, height: 300 },
  kind,
  series: series.map((each) => ({ values: box, ...each })),
  ...more,
});
const dataOf = (
  categories: string[],
  series: Array<{ name: string; values: (number | null)[]; format?: string; sizes?: number[] }>,
  more: Partial<ChartData> = {},
): ChartData => ({
  categories,
  x: null,
  series: series.map((each) => ({
    name: each.name,
    values: each.values,
    sizes: each.sizes ?? null,
    format: each.format,
    broken: false,
  })),
  axisTitles: {},
  ...more,
});
/** The chart as SVG text, the way the library paints it without a page. */
const svgOf = (chart: Chart, data: ChartData, hidden = new Set<number>()) =>
  renderChartSvg(
    createChartScene(compileChart({ chart, data, locale: EN_US, hidden }), {
      width: 480,
      height: 300,
    }),
    {
      ariaLabel: "chart",
    },
  );
const count = (svg: string, pattern: RegExp) => (svg.match(pattern) ?? []).length;

describe("compiling a sheet chart", () => {
  const months = ["Jan", "Feb", "Mar"];

  it("formats the value axis as the cells are, and titles it", () => {
    const svg = svgOf(
      chartOf("column", [{}]),
      dataOf(months, [{ name: "Sales", values: [1000, 2500, 1800], format: "$#,##0" }], {
        axisTitles: { y: "Revenue" },
      }),
    );
    expect(svg).toContain("$2,500");
    expect(svg).toContain("Revenue");
    expect(svg).toContain("Feb");
  });

  it("stacks to a hundred percent, and puts a series on a right axis of its own", () => {
    const percent = svgOf(
      chartOf("column", [{}, {}], { stack: "percent" }),
      dataOf(months, [
        { name: "A", values: [1, 2, 3] },
        { name: "B", values: [3, 2, 1] },
      ]),
    );
    expect(percent).toContain("100%");
    const combo = svgOf(
      chartOf("column", [{}, { kind: "line", axis: "right" }], {
        axes: { y2: { format: "0.0%" } },
      }),
      dataOf(months, [
        { name: "Revenue", values: [100, 200, 300] },
        { name: "Margin", values: [0.1, 0.2, 0.15] },
      ]),
    );
    expect(combo).toContain("20.0%");
    expect(combo).toContain("300");
  });

  it("draws a doughnut's slices, a scatter's trendline, a waterfall and a histogram", () => {
    const pie = svgOf(
      chartOf("doughnut", [{}]),
      dataOf(months, [{ name: "Share", values: [5, 3, 2] }]),
    );
    expect(count(pie, /<path/g)).toBeGreaterThanOrEqual(3);
    const scatter = svgOf(
      chartOf("scatter", [{ trendline: true }]),
      dataOf(["1", "2", "3", "4"], [{ name: "y", values: [2, 4, 5, 8] }], { x: [1, 2, 3, 4] }),
    );
    expect(count(scatter, /<circle/g)).toBeGreaterThanOrEqual(4);
    expect(() =>
      svgOf(
        chartOf("waterfall", [{}]),
        dataOf(["Start", "Fees", "Sales"], [{ name: "Cash", values: [100, -30, 50] }]),
      ),
    ).not.toThrow();
    expect(() =>
      svgOf(
        chartOf("histogram", [{}]),
        dataOf([], [{ name: "Times", values: [1, 2, 2, 3, 3, 3, 4, 4, 5, 9] }]),
      ),
    ).not.toThrow();
  });

  it("leaves out a series the legend hid, and labels points when asked", () => {
    const data = dataOf(months, [
      { name: "Kept", values: [7, 8, 9] },
      { name: "Hidden", values: [70, 80, 90] },
    ]);
    const chart = chartOf("line", [{ labels: { show: true } }, {}]);
    const svg = svgOf(chart, data, new Set([1]));
    // Only the kept series is drawn, so the axis no longer reaches 90.
    expect(svg).not.toContain(">90<");
    expect(svg).toContain(">8<");
  });
});
