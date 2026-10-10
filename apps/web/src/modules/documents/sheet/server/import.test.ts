import { describe, expect, it } from "vitest";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { renderFormula } from "@chat/sheet/model/formula";
import { emptyDoc, liveSheets, positions, sheetNamed, type SheetDoc } from "@chat/sheet/model";
import type { ConditionalRule } from "@chat/sheet/model/conditional";
import type { Validation } from "@chat/sheet/model/validation";
import { exportLiveSheet, importLiveSheet } from "~/modules/spreadsheets/server/adapter.ts";
import { parseLiveSheetOperations } from "../live-operations.ts";
import { convertOperations } from "./convert.ts";
import { liveSheetExport } from "./export.ts";
import { sheetFromCsv, sheetFromWorkbook } from "./import.ts";
import { sheetView } from "./sheet-view.ts";

const settings = { locale: "en-US", timeZone: "UTC" };
const context = { revision: 1, epoch: 0, now: 45_000, seed: 1 };
let minted = 0;
const build = (operations: unknown[]) => {
  const doc = emptyDoc();
  const converted = convertOperations(
    { doc, seen: 0, own: new Set(), mint: () => `m.${++minted}`, context },
    parseLiveSheetOperations(operations),
  );
  if (!converted.ok) throw new Error(converted.message);
  return applyChange(doc, { clientId: "m", seq: 1, ops: converted.ops }, 1).doc;
};
const at = (doc: SheetDoc, name: string, row: number, col: number) => {
  const sheet = sheetNamed(doc, name)!;
  return {
    sheet,
    r: positions(doc.sheet[sheet]!.rows).ids[row - 1]!,
    c: positions(doc.sheet[sheet]!.cols).ids[col - 1]!,
  };
};
const cellOf = (doc: SheetDoc, name: string, row: number, col: number) => {
  const { sheet, r, c } = at(doc, name, row, col);
  return doc.sheet[sheet]!.cells[r]?.[c];
};
const valueOf = (doc: SheetDoc, name: string, row: number, col: number) => {
  const { sheet, r, c } = at(doc, name, row, col);
  return calculateSheet(doc, context).value(sheet, r, c);
};

describe("importing into a live sheet", () => {
  it("brings back what an export wrote: formulas, formats, layout and names", async () => {
    const original = build([
      { kind: "addSheet", name: "Rates" },
      { kind: "setCells", sheet: "Rates", start: "A1", rows: [[0.2]] },
      { kind: "defineName", name: "Tax", sheet: "Rates", range: "A1" },
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Item", "Net", "Gross"],
          ["Tea", 10, "=B2*(1+Tax)"],
          [null, null, "=SEQUENCE(2)"],
        ],
      },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:C1", bold: true, fill: "#FFEE00" },
      { kind: "setFormat", sheet: "Sheet1", range: "C2", numberFormat: "0.00" },
      { kind: "mergeCells", sheet: "Sheet1", range: "D1:E1" },
      { kind: "freezePanes", sheet: "Sheet1", cell: "A2" },
      { kind: "setColumnWidth", sheet: "Sheet1", columns: "A", width: 20 },
    ]);
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const { doc } = imported;
    expect(doc.sheets.map((each) => doc.sheet[each.id]!.name)).toEqual(["Sheet1", "Rates"]);
    const gross = cellOf(doc, "Sheet1", 2, 3)!;
    expect(renderFormula(gross.f!, { doc, sheet: "s1" })).toBe("B2*(1+Tax)");
    expect(valueOf(doc, "Sheet1", 2, 3)).toBe(12);
    expect(valueOf(doc, "Sheet1", 4, 3)).toBe(2);
    expect(JSON.parse(cellOf(doc, "Sheet1", 1, 1)!.s!)).toMatchObject({
      bold: true,
      fill: "#FFEE00",
    });
    expect(JSON.parse(gross.s!)).toEqual({ numberFormat: "0.00" });
    const sheet = doc.sheet.s1!;
    expect(sheet.merges).toHaveLength(1);
    expect(sheet.freeze).toEqual({ row: "s1.r1", col: null });
    expect(sheet.colProps["s1.c1"]?.size).toBe(20);
    expect(read.dropped).toEqual([]);
  });

  it("keeps underline, strikethrough and a font through Excel and back", async () => {
    const original = build([
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["Title", "Old"]] },
      { kind: "setFormat", sheet: "Sheet1", range: "A1", underline: true, font: "Georgia" },
      { kind: "setFormat", sheet: "Sheet1", range: "B1", strike: true },
    ]);
    const imported = sheetFromWorkbook(
      await importLiveSheet(await exportLiveSheet(liveSheetExport(original))),
      settings,
    );
    if (!imported.ok) throw new Error(imported.reason);
    expect(JSON.parse(cellOf(imported.doc, "Sheet1", 1, 1)!.s!)).toEqual({
      underline: true,
      fontFamily: "Georgia",
    });
    expect(JSON.parse(cellOf(imported.doc, "Sheet1", 1, 2)!.s!)).toEqual({ strike: true });
  });

  it("keeps links through Excel and back, without the look Excel gives them", async () => {
    const original = build([
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["Docs", "Mail"]] },
      { kind: "setFormat", sheet: "Sheet1", range: "A1", link: "https://example.com/docs" },
      {
        kind: "setFormat",
        sheet: "Sheet1",
        range: "B1",
        link: "mailto:ana@example.com",
        bold: true,
      },
    ]);
    expect(() =>
      build([{ kind: "setFormat", sheet: "Sheet1", range: "A1", link: "javascript:x" }]),
    ).toThrow();
    const imported = sheetFromWorkbook(
      await importLiveSheet(await exportLiveSheet(liveSheetExport(original))),
      settings,
    );
    if (!imported.ok) throw new Error(imported.reason);
    expect(JSON.parse(cellOf(imported.doc, "Sheet1", 1, 1)!.s!)).toEqual({
      link: "https://example.com/docs",
    });
    expect(JSON.parse(cellOf(imported.doc, "Sheet1", 1, 2)!.s!)).toEqual({
      bold: true,
      link: "mailto:ana@example.com",
    });
    expect(sheetView(imported.doc, calculateSheet(imported.doc, context)).xml).toContain(
      'link="https://example.com/docs"',
    );
  });

  it("writes open comment threads as notes, and reads notes back as threads", async () => {
    const doc = applyChange(
      build([{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["Total", 5]] }]),
      {
        clientId: "t",
        seq: 1,
        ops: [
          { op: "anchor", thread: "t1", at: { sh: "s1", r: "s1.r1", c: "s1.c2" } },
          { op: "anchor", thread: "t2", at: { sh: "s1", r: "s1.r1", c: "s1.c1" } },
        ],
      },
      2,
    ).doc;
    const comment = (id: string, threadId: string, body: string, extra = {}) => ({
      id,
      threadId,
      author: { id: "u1", name: "Ana" },
      byAssistant: false,
      fromFile: null,
      body,
      createdAt: "2026-10-10T00:00:00.000Z",
      resolvedAt: null,
      quote: null,
      toAssistant: false,
      answered: false,
      ...extra,
    });
    const comments = [
      comment("t1", "t1", "Is this right?"),
      comment("r1", "t1", "Yes.", { author: null, byAssistant: true }),
      comment("t2", "t2", "Done", { resolvedAt: "2026-10-10T01:00:00.000Z" }),
    ];
    const read = await importLiveSheet(
      await exportLiveSheet(liveSheetExport(doc, undefined, comments)),
    );
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    // The resolved thread stays behind. A note has no replies, so the open one's are in its text.
    expect(imported.notes).toEqual([
      {
        cell: { sh: "s1", r: "s1.r1", c: "s1.c2" },
        entries: [{ author: "Ana", text: "Is this right?\n\nAssistant: Yes." }],
      },
    ]);
  });

  it("keeps grouped rows and columns through Excel and back, collapsed ones folded", async () => {
    const original = build([
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["a"], ["b"], ["c"], ["d"]] },
      { kind: "group", sheet: "Sheet1", rows: "2:9" },
      { kind: "group", sheet: "Sheet1", rows: "3:4", collapsed: true },
      { kind: "group", sheet: "Sheet1", columns: "B:D" },
    ]);
    expect(() => build([{ kind: "group", sheet: "Sheet1", rows: "2", columns: "B" }])).toThrow();
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const sheet = imported.doc.sheet.s1!;
    expect(sheet.outline).toEqual({
      rows: [
        { from: "s1.r2", to: "s1.r9" },
        { from: "s1.r3", to: "s1.r4", collapsed: true },
      ],
      cols: [{ from: "s1.c2", to: "s1.c4" }],
    });
    // A collapsed group's rows are the group's to show, not hidden by hand.
    expect(sheet.rowProps["s1.r3"]?.hidden).toBeUndefined();
    expect(sheetView(imported.doc, calculateSheet(imported.doc, context)).xml).toContain(
      "<groups>2:9, 3:4 collapsed, B:D</groups>",
    );
  });

  it("keeps a GROUPBY pivot through Excel and back, calculating the same", async () => {
    const original = build([
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Region", "Sales"],
          ["North", 10],
          ["South", 5],
          ["North", 1],
        ],
      },
      { kind: "setCells", sheet: "Sheet1", start: "D1", rows: [["=GROUPBY(A1:A4, B1:B4, SUM)"]] },
    ]);
    const imported = sheetFromWorkbook(
      await importLiveSheet(await exportLiveSheet(liveSheetExport(original))),
      settings,
    );
    if (!imported.ok) throw new Error(imported.reason);
    const { r, c } = at(imported.doc, "Sheet1", 1, 4);
    expect(
      renderFormula(imported.doc.sheet.s1!.cells[r]![c]!.f!, { doc: imported.doc, sheet: "s1" }),
    ).toBe("GROUPBY(A1:A4, B1:B4, SUM)");
    const values = calculateSheet(imported.doc, context);
    const shown = (row: number, col: number) => {
      const cell = at(imported.doc, "Sheet1", row, col);
      return values.value("s1", cell.r, cell.c);
    };
    expect([shown(2, 4), shown(2, 5), shown(4, 4), shown(4, 5)]).toEqual([
      "North",
      11,
      "Total",
      16,
    ]);
  });

  it("keeps a picture through Excel and back, where it sat and at its size", async () => {
    const src =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const original = applyChange(
      build([{ kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["x"]] }]),
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "imagePut",
            id: "p1",
            image: {
              sheet: "s1",
              at: { r: "s1.r3", c: "s1.c2" },
              offset: { x: 12, y: 4 },
              size: { width: 160, height: 90 },
              src,
              alt: "Logo",
            },
          },
        ],
      },
      2,
    ).doc;
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    expect(Object.values(imported.doc.images ?? {})).toEqual([
      {
        sheet: "s1",
        at: { r: "s1.r3", c: "s1.c2" },
        offset: { x: 12, y: 4 },
        size: { width: 160, height: 90 },
        src,
        alt: "Logo",
      },
    ]);
    expect(sheetView(imported.doc, calculateSheet(imported.doc, context)).xml).toContain(
      '<picture at="B3" size="160x90" alt="Logo"/>',
    );
  });

  it("keeps a tab's colour through Excel and back, and shows it to the model", async () => {
    const original = build([{ kind: "colorSheet", sheet: "Sheet1", color: "#c00000" }]);
    const imported = sheetFromWorkbook(
      await importLiveSheet(await exportLiveSheet(liveSheetExport(original))),
      settings,
    );
    if (!imported.ok) throw new Error(imported.reason);
    expect(imported.doc.sheet[liveSheets(imported.doc)[0]!]!.color).toBe("#C00000");
    expect(sheetView(imported.doc, calculateSheet(imported.doc, context)).xml).toContain(
      'color="#C00000"',
    );
  });

  it("keeps hidden rows and columns and a filter through Excel and back", async () => {
    let original = build([
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Region", "Total", "Note"],
          ["North", 120, "a"],
          ["South", 80, "b"],
          ["North", 40, "c"],
        ],
      },
    ]);
    original = applyChange(
      original,
      {
        clientId: "t",
        seq: 9,
        ops: [
          { op: "hide", sh: "s1", axis: "columns", ids: ["s1.c3"], hidden: true },
          { op: "hide", sh: "s1", axis: "rows", ids: ["s1.r6"], hidden: true },
          {
            op: "filter",
            sh: "s1",
            filter: {
              box: { r1: "s1.r1", r2: "s1.r4", c1: "s1.c1", c2: "s1.c2" },
              rules: { "s1.c2": { condition: { op: "greater", value: 50 } } },
            },
          },
        ],
      },
      9,
    ).doc;
    const values = calculateSheet(original, context);
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original, values)));
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const sheet = imported.doc.sheet.s1!;
    expect(sheet.colProps["s1.c3"]?.hidden).toBe(true);
    // Row 4, which only the filter hid, is the filter's again, not hidden by hand.
    expect([sheet.rowProps["s1.r6"]?.hidden, sheet.rowProps["s1.r4"]?.hidden]).toEqual([
      true,
      undefined,
    ]);
    expect(sheet.filter).toEqual({
      box: { r1: "s1.r1", r2: "s1.r4", c1: "s1.c1", c2: "s1.c2" },
      rules: { "s1.c2": { values: ["120", "80"] } },
    });
  });

  it("keeps every kind of conditional format through Excel and back", async () => {
    let original = build([
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[10], [40], ["North"], [""]] },
    ]);
    const box = { r1: "s1.r1", r2: "s1.r4", c1: "s1.c1", c2: "s1.c1" };
    const red = { fill: "#FFC7CE", fontColor: "#9C0006" };
    const rules: ConditionalRule[] = [
      { kind: "compare", op: "between", values: [5, 20], style: red },
      { kind: "compare", op: "equal", values: ["North"], style: { bold: true } },
      { kind: "text", op: "beginsWith", text: "No", style: { fontColor: "#006100" } },
      { kind: "top", count: 10, percent: true, bottom: true, style: red },
      { kind: "average", below: true, style: red },
      { kind: "duplicate", unique: true, style: { fill: "#FFEB9C", italic: true } },
      { kind: "blank", style: red },
      { kind: "scale", colors: ["#F8696B", "#FFEB84", "#63BE7B"] },
      { kind: "bar", color: "#638EC6" },
    ];
    original = applyChange(
      original,
      {
        clientId: "t",
        seq: 9,
        ops: [
          {
            op: "conditional",
            sh: "s1",
            list: rules.map((rule, index) => ({ id: `r${index}`, box, rule })),
          },
        ],
      },
      9,
    ).doc;
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const list = imported.doc.sheet.s1!.conditional!;
    expect(list.map((each) => each.rule)).toEqual(rules);
    expect(list[0]!.box).toEqual(box);
  });

  it("keeps data validation through Excel and back, lists read from cells included", async () => {
    let original = build([
      { kind: "addSheet", name: "Lists" },
      { kind: "setCells", sheet: "Lists", start: "A1", rows: [["Open"], ["Done"]] },
    ]);
    const box = (c: number) => ({ r1: "s1.r1", r2: "s1.r5", c1: `s1.c${c}`, c2: `s1.c${c}` });
    const lists = sheetNamed(original, "Lists")!;
    const listRows = positions(original.sheet[lists]!.rows).ids;
    const listCols = positions(original.sheet[lists]!.cols).ids;
    const validations: Validation[] = [
      {
        id: "a",
        box: box(1),
        rule: { kind: "list", values: ["Yes", "No"] },
        onError: "stop",
        allowBlank: true,
      },
      {
        id: "b",
        box: box(2),
        rule: {
          kind: "list",
          source: {
            sh: lists,
            box: { r1: listRows[0]!, r2: listRows[1]!, c1: listCols[0]!, c2: listCols[0]! },
          },
        },
        onError: "warning",
        allowBlank: false,
        message: "Pick a status",
      },
      {
        id: "c",
        box: box(3),
        rule: { kind: "whole", test: "between", values: [1, 10] },
        onError: "stop",
        allowBlank: true,
      },
      {
        id: "d",
        box: box(4),
        rule: { kind: "length", test: "lessOrEqual", values: [20] },
        onError: "information",
        allowBlank: true,
      },
    ];
    original = applyChange(
      original,
      { clientId: "t", seq: 9, ops: [{ op: "validations", sh: "s1", list: validations }] },
      9,
    ).doc;
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const back = imported.doc.sheet.s1!.validations!;
    // The list's cells, on the imported Lists sheet's own IDs.
    const listsAgain = sheetNamed(imported.doc, "Lists")!;
    const sourceAgain = {
      sh: listsAgain,
      box: {
        r1: `${listsAgain}.r1`,
        r2: `${listsAgain}.r2`,
        c1: `${listsAgain}.c1`,
        c2: `${listsAgain}.c1`,
      },
    };
    expect(back.map(({ id: _id, ...rest }) => rest)).toEqual(
      validations.map(({ id: _id, ...rest }) =>
        rest.rule.kind === "list" && rest.rule.source
          ? { ...rest, rule: { kind: "list", source: sourceAgain } }
          : rest,
      ),
    );
  });

  it("keeps a chart's options through Excel and back", async () => {
    const rows = [
      ["Month", "Revenue", "Costs"],
      ["Jan", 100, 60],
      ["Feb", 140, 80],
      ["Mar", 120, 70],
    ];
    const kinds = [
      { type: "column", stack: "stacked", at: "E2" },
      { type: "line", at: "E20" },
      { type: "doughnut", at: "M2", hole: 0.4, labels: true },
      { type: "scatter", at: "M20" },
      { type: "bar", at: "E40" },
      { type: "waterfall", at: "U2" },
      { type: "histogram", at: "U20" },
    ];
    const built = build([
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows },
      ...kinds.map(({ type, ...rest }) => ({
        kind: "addChart",
        sheet: "Sheet1",
        type,
        title: `${type} chart`,
        legend: "right",
        yAxis: { title: "Money", min: 0, max: 200, format: "$#,##0", gridlines: true },
        ...(type === "line" || type === "scatter"
          ? {
              categories: type === "scatter" ? "B2:B4" : "A2:A4",
              series: [
                {
                  values: "C2:C4",
                  name: "=C1",
                  color: "#FF0000",
                  smooth: type === "line",
                  markers: type === "line",
                  dashed: type === "line",
                  trendline: type === "scatter",
                  labels: true,
                },
              ],
            }
          : { range: "A1:C4" }),
        ...rest,
      })),
    ]);
    // A chart dropped part way into its cell keeps that place.
    const original = applyChange(
      built,
      {
        clientId: "t",
        seq: 1,
        ops: [
          {
            op: "chartPatch",
            id: Object.keys(built.charts)[0]!,
            patch: { offset: { x: 30, y: 7 } },
          },
        ],
      },
      2,
    ).doc;
    const read = await importLiveSheet(await exportLiveSheet(liveSheetExport(original)));
    expect(read.dropped).toEqual([]);
    const imported = sheetFromWorkbook(read, settings);
    if (!imported.ok) throw new Error(imported.reason);
    const charts = Object.values(imported.doc.charts);
    expect(charts.map((each) => each.kind)).toEqual([
      "column",
      "line",
      "doughnut",
      "scatter",
      "bar",
      "waterfall",
      "histogram",
    ]);
    expect(charts[5]).toMatchObject({ title: { text: "waterfall chart" } });
    const [column, line, doughnut, scatter, bar] = charts;
    expect(column).toMatchObject({
      stack: "stacked",
      title: { text: "column chart" },
      legend: "right",
      axes: {
        y: { title: { text: "Money" }, min: 0, max: 200, format: "$#,##0", gridlines: true },
      },
      series: [
        { name: { cell: { sh: "s1", r: "s1.r1", c: "s1.c2" } } },
        { name: { cell: { sh: "s1", r: "s1.r1", c: "s1.c3" } } },
      ],
    });
    expect(column!.series[0]!.categories).toEqual({
      r1: "s1.r2",
      r2: "s1.r4",
      c1: "s1.c1",
      c2: "s1.c1",
    });
    expect(line!.series[0]).toMatchObject({
      color: "#FF0000",
      labels: { show: true },
      line: { smooth: true, markers: true, dashed: true },
    });
    expect(doughnut).toMatchObject({ style: { hole: 0.4, labels: { show: true } } });
    expect(doughnut!.series).toHaveLength(1);
    expect(scatter!.series[0]).toMatchObject({ trendline: true });
    // A bar chart's value axis runs along the bottom, so its options stay with the vertical axis.
    expect(bar).toMatchObject({ axes: { y: { min: 0, max: 200 } } });
    expect(column!.at).toEqual(original.charts[Object.keys(original.charts)[0]!]!.at);
    expect([column!.offset, line!.offset]).toEqual([{ x: 30, y: 7 }, undefined]);
  });

  it("reads CSV in either convention, quoted fields and formulas included", () => {
    const us = sheetFromCsv(
      'Item,Amount\n"Tea, green",1234.5\nTotal,=SUM(B2:B2)\n',
      "Costs",
      settings,
    );
    if (!us.ok) throw new Error(us.reason);
    expect(valueOf(us.doc, "Costs", 2, 1)).toBe("Tea, green");
    expect(valueOf(us.doc, "Costs", 3, 2)).toBe(1234.5);
    const eu = sheetFromCsv("Artikel;Betrag\nTee;1,5\n", "Kosten", settings);
    if (!eu.ok) throw new Error(eu.reason);
    expect(valueOf(eu.doc, "Kosten", 2, 2)).toBe(1.5);
  });
});
