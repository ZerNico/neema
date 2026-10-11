import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChange } from "./apply.ts";
import { calculateSheet } from "./calc.ts";
import {
  chartData,
  patchChart,
  readSource,
  rebuildSeries,
  seriesFrom,
  suggestKinds,
  type Chart,
  type ChartPatch,
} from "./chart.ts";
import { invertChange } from "./invert.ts";
import { emptyDoc, type Box, type SheetDoc } from "./model.ts";
import type { SheetOp } from "./ops.ts";

const context = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let revision = 0;
const apply = (doc: SheetDoc, ...ops: SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const id = (axis: "r" | "c", n: number) => `s1.${axis}${n}`;
const box = (r1: number, c1: number, r2: number, c2: number): Box => ({
  r1: id("r", r1),
  r2: id("r", r2),
  c1: id("c", c1),
  c2: id("c", c2),
});
/** A sheet holding these rows from A1. */
const table = (
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>,
  formats: SheetOp[] = [],
) =>
  apply(
    emptyDoc(),
    {
      op: "set",
      sh: "s1",
      cells: rows.flatMap((row, y) =>
        row.map((v, x) => ({ r: id("r", y + 1), c: id("c", x + 1), v })),
      ),
    },
    ...formats,
  );
const values = (doc: SheetDoc) => calculateSheet(doc, context);
const chartOf = (doc: SheetDoc, area: Box, kind: Chart["kind"] = "column"): Chart => {
  const source = readSource(doc, values(doc), "s1", area);
  return {
    sheet: "s1",
    at: { r: id("r", 1), c: id("c", 8) },
    size: { width: 480, height: 300 },
    kind,
    series: seriesFrom(doc, source, kind),
    source,
  };
};

describe("reading a range for a chart, as Excel does", () => {
  const sales = table([
    ["Month", "Sales", "Costs"],
    ["Jan", 10, 4],
    ["Feb", 20, 6],
    ["Mar", 15, 9],
  ]);

  it("takes a header row as series names and a first column as point labels", () => {
    expect(readSource(sales, values(sales), "s1", box(1, 1, 4, 3))).toMatchObject({
      headers: true,
      labels: true,
      byRow: false,
    });
    const data = chartData(sales, values(sales), chartOf(sales, box(1, 1, 4, 3)));
    expect(data.categories).toEqual(["Jan", "Feb", "Mar"]);
    expect(data.series.map((each) => [each.name, each.values])).toEqual([
      ["Sales", [10, 20, 15]],
      ["Costs", [4, 6, 9]],
    ]);
  });

  it("runs series along rows when the numbers are wider than tall", () => {
    const wide = table([
      [1, 2, 3, 4, 5],
      [6, 7, 8, 9, 10],
    ]);
    const source = readSource(wide, values(wide), "s1", box(1, 1, 2, 5));
    expect(source).toMatchObject({ headers: false, labels: false, byRow: true });
    expect(seriesFrom(wide, source, "line")).toHaveLength(2);
  });

  it("reads a scatter's first column as x, and labels dates as the sheet shows them", () => {
    const xy = table([
      [1, 2],
      [2, 4],
      [3, 9],
    ]);
    const data = chartData(xy, values(xy), chartOf(xy, box(1, 1, 3, 2), "scatter"));
    expect([data.x, data.series[0]!.values]).toEqual([
      [1, 2, 3],
      [2, 4, 9],
    ]);
    const dated = table(
      [
        ["Day", "Visits"],
        [45_000, 3],
        [45_001, 5],
      ],
      [
        {
          op: "format",
          sh: "s1",
          area: { r1: id("r", 2), r2: id("r", 3), c1: id("c", 1), c2: id("c", 1) },
          patch: { numberFormat: "yyyy-mm-dd" },
        },
      ],
    );
    const source = readSource(dated, values(dated), "s1", box(1, 1, 3, 2));
    expect(source.labels).toBe(true);
    expect(chartData(dated, values(dated), chartOf(dated, box(1, 1, 3, 2))).categories).toEqual([
      "2023-03-15",
      "2023-03-16",
    ]);
    expect(suggestKinds(dated, values(dated), source)[0]).toBe("line");
  });

  it("suggests a pie for a few positive parts, and says when a range is gone", () => {
    const source = readSource(sales, values(sales), "s1", box(1, 1, 4, 2));
    expect(suggestKinds(sales, values(sales), source).slice(0, 2)).toEqual(["pie", "doughnut"]);
    const chart = chartOf(sales, box(1, 1, 4, 3));
    const gone = apply(sales, { op: "delete", sh: "s1", axis: "columns", ids: [id("c", 2)] });
    // The deleted column's series has nothing left; the other keeps its cells.
    const data = chartData(gone, values(gone), chart);
    expect(data.series.map((each) => each.broken)).toEqual([true, false]);
  });

  it("leaves a table's text columns out of its series", () => {
    const orders = table([
      ["Order", "Customer", "Quantity", "Region", "Total"],
      ["A-1", "Acme", 12, "North", 240],
      ["A-2", "Orbit", 5, "South", 250],
    ]);
    const source = readSource(orders, values(orders), "s1", box(1, 1, 3, 5));
    const series = seriesFrom(orders, source, "column", values(orders));
    expect(series.map((each) => each.values.c1)).toEqual([id("c", 3), id("c", 5)]);
  });

  it("rebuilds series from a changed range, keeping each one's own options", () => {
    const chart = chartOf(sales, box(1, 1, 4, 3));
    const coloured = {
      ...chart,
      series: chart.series.map((each, index) =>
        index === 0 ? { ...each, color: "#FF0000" } : each,
      ),
    };
    const rebuilt = rebuildSeries(sales, coloured, { ...chart.source!, byRow: true });
    expect(rebuilt.series[0]).toMatchObject({ color: "#FF0000" });
    expect(rebuilt.series).toHaveLength(3);
  });
});

describe("changing a chart", () => {
  const doc = apply(table([["a", 1]]), {
    op: "chartPut",
    id: "c1",
    chart: {
      sheet: "s1",
      at: { r: id("r", 1), c: id("c", 4) },
      size: { width: 480, height: 300 },
      kind: "column",
      legend: "bottom",
      axes: { y: { title: { text: "Units" } } },
      series: [{ values: box(1, 2, 1, 2) }],
    },
  });

  it("patches one option at a time, axes and style merged a level down", () => {
    const patched = patchChart(doc.charts.c1!, {
      title: { text: "Sales" },
      legend: null,
      axes: { y: { min: 0 }, y2: { log: true } },
    });
    expect(patched).toMatchObject({
      title: { text: "Sales" },
      axes: { y: { min: 0 }, y2: { log: true } },
    });
    expect(patched.legend).toBeUndefined();
    // Each axis is replaced whole: the y title went with the new y.
    expect(patched.axes?.y?.title).toBeUndefined();
  });

  it("undoes any patch back to the chart it was", () => {
    const patch = fc.record(
      {
        title: fc.oneof(
          fc.constant(null),
          fc.string({ maxLength: 20 }).map((text) => ({ text })),
        ),
        legend: fc.constantFrom(null, "top", "bottom", "left", "right", "none"),
        stack: fc.constantFrom(null, "none", "stacked", "percent"),
        kind: fc.constantFrom("column", "line", "pie", "bar"),
        axes: fc.record(
          {
            y: fc.oneof(
              fc.constant(null),
              fc.record({ min: fc.integer(), gridlines: fc.boolean() }),
            ),
          },
          { requiredKeys: [] },
        ),
        style: fc.record({ hole: fc.constantFrom(null, 0.5) }, { requiredKeys: [] }),
      },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(patch, (each) => {
        const after = apply(doc, { op: "chartPatch", id: "c1", patch: each as ChartPatch });
        const undone = apply(after, ...invertChange(doc, after));
        expect(undone.charts).toEqual(doc.charts);
      }),
      { numRuns: 200 },
    );
  });
});
