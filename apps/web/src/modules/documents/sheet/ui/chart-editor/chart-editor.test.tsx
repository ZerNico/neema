import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { readSource, seriesFrom, type Chart, type ChartPatch } from "@chat/sheet/model/chart";
import { emptyDoc } from "@chat/sheet/model";
import { ChartEditor } from "./chart-editor.tsx";

afterEach(cleanup);

const rows = [
  ["Month", "Sales", "Costs"],
  ["Jan", 10, 4],
  ["Feb", 20, 6],
  ["Mar", 15, 9],
];
const doc = applyChange(
  emptyDoc(),
  {
    clientId: "t",
    seq: 1,
    ops: [
      {
        op: "set",
        sh: "s1",
        cells: rows.flatMap((row, y) =>
          row.map((v, x) => ({ r: `s1.r${y + 1}`, c: `s1.c${x + 1}`, v })),
        ),
      },
    ],
  },
  1,
).doc;
const values = calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 });
const box = { r1: "s1.r1", r2: "s1.r4", c1: "s1.c1", c2: "s1.c3" };
const source = readSource(doc, values, "s1", box);
const chart: Chart = {
  sheet: "s1",
  at: { r: "s1.r1", c: "s1.c5" },
  size: { width: 480, height: 300 },
  kind: "column",
  legend: "bottom",
  series: seriesFrom(doc, source, "column"),
  source,
};

function open(readOnly = false) {
  const patches: ChartPatch[] = [];
  render(
    <ChartEditor
      doc={doc}
      values={values}
      chart={chart}
      readOnly={readOnly}
      selection={{ sheet: "s1", box: { r1: "s1.r2", r2: "s1.r4", c1: "s1.c3", c2: "s1.c3" } }}
      patch={(patch) => patches.push(patch)}
      onClose={() => {}}
    />,
  );
  return patches;
}

describe("the chart editor", () => {
  it("shows the range and series it draws, and changes kind by reading the range again", () => {
    const patches = open();
    expect(screen.getByLabelText<HTMLInputElement>("Data range").value).toBe("A1:C4");
    expect(screen.getByText("Sales")).toBeTruthy();
    expect(screen.getByText("Costs")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Doughnut" })[0]!);
    expect(patches[0]).toMatchObject({ kind: "doughnut" });
    expect(patches[0]!.series).toHaveLength(1);
    fireEvent.click(screen.getByRole("switch", { name: "Switch rows and columns" }));
    expect(patches[1]).toMatchObject({ source: { byRow: true } });
    expect(patches[1]!.series).toHaveLength(3);
  });

  it("titles the chart from a cell, and takes a range typed in only once let go", () => {
    const patches = open();
    const range = screen.getByLabelText<HTMLInputElement>("Data range");
    fireEvent.change(range, { target: { value: "A1:B4" } });
    expect(patches).toHaveLength(0);
    fireEvent.keyDown(range, { key: "Enter" });
    expect(patches[0]!.series).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Customize" }));
    const title = screen.getAllByLabelText<HTMLInputElement>("Title")[0]!;
    fireEvent.change(title, { target: { value: "=B1" } });
    fireEvent.blur(title);
    expect(patches[1]).toEqual({ title: { cell: { sh: "s1", r: "s1.r1", c: "s1.c2" } } });
  });

  it("adds the selection as a series", () => {
    const patches = open();
    fireEvent.click(screen.getByRole("button", { name: "Add series from selection" }));
    expect(patches[0]!.series!.at(-1)).toMatchObject({
      values: { r1: "s1.r2", r2: "s1.r4", c1: "s1.c3", c2: "s1.c3" },
    });
  });

  it("lets a reader look but not change", () => {
    open(true);
    expect(screen.getByLabelText<HTMLInputElement>("Data range").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Add series from selection" })).toBeNull();
  });
});
