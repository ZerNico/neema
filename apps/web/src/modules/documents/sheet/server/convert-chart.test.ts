import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet, type CalcContext } from "@chat/sheet/model/calc";
import { emptyDoc, type SheetDoc } from "@chat/sheet/model";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { sheetView } from "./sheet-view.ts";

const context: CalcContext = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let minted = 0;
let revision = 0;
const edit = (doc: SheetDoc, operations: unknown[]) => {
  const converted = convertOperations(
    { doc, seen: revision, own: new Set(), mint: () => `m.${++minted}`, context },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) throw new Error(converted.message);
  revision += 1;
  return applyChange(doc, { clientId: "m", seq: revision, ops: converted.ops }, revision).doc;
};
const sales = edit(emptyDoc(), [
  {
    kind: "setCells",
    sheet: "Sheet1",
    start: "A1",
    rows: [
      ["Month", "Revenue", "Margin"],
      ["Jan", 100, 0.2],
      ["Feb", 140, 0.25],
      ["Mar", 120, 0.22],
    ],
  },
]);
const only = (doc: SheetDoc) => {
  const [entry] = Object.entries(doc.charts);
  return { id: entry![0], chart: entry![1] };
};

describe("the model's chart operations", () => {
  it("reads a range as a selection, and takes every option at once", () => {
    const doc = edit(sales, [
      {
        kind: "addChart",
        sheet: "Sheet1",
        at: "E2",
        type: "column",
        range: "A1:C4",
        title: "=B1",
        yAxis: { title: "Revenue", min: 0, format: "$#,##0" },
        rightAxis: { format: "0%" },
        legend: "top",
      },
    ]);
    const { chart } = only(doc);
    expect(chart).toMatchObject({
      kind: "column",
      legend: "top",
      title: { cell: { sh: "s1", r: "s1.r1", c: "s1.c2" } },
      axes: { y: { title: { text: "Revenue" }, min: 0, format: "$#,##0" }, y2: { format: "0%" } },
      source: { headers: true, labels: true },
    });
    expect(chart.series).toHaveLength(2);
    expect(chart.series[0]!.categories).toEqual({
      r1: "s1.r2",
      r2: "s1.r4",
      c1: "s1.c1",
      c2: "s1.c1",
    });
  });

  it("changes only what an edit gives, merging an axis and reading the range again for a new kind", () => {
    let doc = edit(sales, [
      {
        kind: "addChart",
        sheet: "Sheet1",
        at: "E2",
        type: "line",
        range: "A1:C4",
        yAxis: { title: "Revenue", min: 0 },
      },
    ]);
    const { id } = only(doc);
    doc = edit(doc, [
      {
        kind: "editChart",
        chart: id,
        yAxis: { max: 200 },
        series: [
          { values: "B2:B4", name: "Revenue" },
          { values: "C2:C4", name: "=C1", as: "column", axis: "right", labels: true },
        ],
        categories: "A2:A4",
      },
    ]);
    let { chart } = only(doc);
    expect(chart.axes?.y).toEqual({ title: { text: "Revenue" }, min: 0, max: 200 });
    expect(chart.series[1]).toMatchObject({
      kind: "column",
      axis: "right",
      labels: { show: true },
    });
    // Series given by hand no longer follow the range.
    expect(chart.source).toBeUndefined();
    doc = edit(doc, [
      { kind: "editChart", chart: id, type: "pie", labels: true, clear: ["yAxis", "title"] },
    ]);
    ({ chart } = only(doc));
    expect(chart).toMatchObject({
      kind: "pie",
      style: { labels: { show: true, content: "percent" } },
    });
    expect(chart.series).toHaveLength(1);
  });

  it("shows the model every option a chart has in its view", () => {
    const doc = edit(sales, [
      {
        kind: "addChart",
        sheet: "Sheet1",
        at: "E2",
        type: "column",
        range: "A1:C4",
        stack: "stacked",
        yAxis: { format: "$#,##0" },
      },
    ]);
    const shown = sheetView(doc, calculateSheet(doc, context), {}).xml;
    expect(shown).toContain(
      'type="column" at="E2" size="480x300" range="Sheet1!A1:C4" stack="stacked"',
    );
    expect(shown).toContain(
      '<series values="Sheet1!B2:B4" name="=Sheet1!B1" categories="Sheet1!A2:A4"/>',
    );
    expect(shown).toContain('<yAxis format="$#,##0"/>');
  });

  it("refuses an unknown chart and text that names a range", () => {
    expect(() => edit(sales, [{ kind: "editChart", chart: "nope", title: "x" }])).toThrow(
      /No chart nope/,
    );
    expect(() =>
      edit(sales, [
        {
          kind: "addChart",
          sheet: "Sheet1",
          at: "E2",
          type: "column",
          range: "A1:C4",
          title: "=A1:B2",
        },
      ]),
    ).toThrow(/one cell/);
    expect(() =>
      parseLiveSheetOperations([
        {
          kind: "addChart",
          sheet: "Sheet1",
          at: "E2",
          type: "column",
          range: "A1:C4",
          series: [{ values: "B2:B4" }],
        },
      ]),
    ).toThrow();
  });
});
