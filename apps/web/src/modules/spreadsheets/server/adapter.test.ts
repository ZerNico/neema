import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { makeFormula, makeSharedFormula } from "@office-kit/xlsx/cell";
import { workbookToBytes } from "@office-kit/xlsx/io";
import { addWorksheet, createWorkbook } from "@office-kit/xlsx/workbook";
import { setCell } from "@office-kit/xlsx/worksheet";
import { describe, expect, it } from "vitest";
import { createSpreadsheet, editSpreadsheet, inspectSpreadsheet } from "./adapter.ts";
import { previewChart, previewSpreadsheet } from "./preview.ts";

const edit = async (bytes: Uint8Array, operations: unknown[]) => editSpreadsheet(bytes, operations);
const cellsOf = async (bytes: Uint8Array, sheet?: string, range?: string) =>
  Object.fromEntries(
    (
      await inspectSpreadsheet(bytes, { ...(sheet ? { sheet } : {}), ...(range ? { range } : {}) })
    ).window!.cells.map((cell) => [cell.cell, cell]),
  );

describe("spreadsheet adapter", () => {
  it("writes values and formulas, calculates them across sheets and names, and stores results", async () => {
    const created = await createSpreadsheet();
    const first = await edit(created, [
      { kind: "renameSheet", sheet: "Sheet1", name: "Data" },
      {
        kind: "setCells",
        sheet: "Data",
        start: "A1",
        rows: [
          ["Month", "Sales"],
          ["Jan", 10],
          ["Feb", 20],
          ["Mar", 30],
          ["Total", "=SUM(B2:B4)"],
        ],
      },
      { kind: "defineName", name: "Sales", sheet: "Data", range: "B2:B4" },
      { kind: "addSheet", name: "Summary" },
      {
        kind: "setCells",
        sheet: "Summary",
        start: "A1",
        rows: [["=Data!B5*2", "=AVERAGE(Sales)", '=XLOOKUP("Feb",Data!A2:A4,Data!B2:B4)']],
      },
    ]);
    expect(first.formulaErrors.count).toBe(0);
    expect(first.formulaResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sheet: "Data", cell: "B5", value: "60", formula: "=SUM(B2:B4)" }),
        expect.objectContaining({ sheet: "Summary", cell: "A1", value: "120" }),
        expect.objectContaining({ sheet: "Summary", cell: "B1", value: "20" }),
        expect.objectContaining({ sheet: "Summary", cell: "C1", value: "20" }),
      ]),
    );
    // Newer functions carry Excel's namespace in the file.
    const summary = await cellsOf(first.bytes, "Summary");
    expect(summary.C1).toMatchObject({ formula: expect.stringContaining("_xlfn.XLOOKUP") });
    expect((await inspectSpreadsheet(first.bytes)).names).toEqual([
      { name: "Sales", refersTo: "Data!$B$2:$B$4" },
    ]);
  });

  it("formats without losing what a cell already had, and shows numbers as formatted", async () => {
    const start = await edit(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[1234.5, 0.25]] },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:B1", fontSize: 14 },
      { kind: "setFormat", sheet: "Sheet1", range: "A1", bold: true, numberFormat: "#,##0.00" },
      { kind: "setFormat", sheet: "Sheet1", range: "B1", numberFormat: "0%" },
      { kind: "mergeCells", sheet: "Sheet1", range: "C1:D1" },
      { kind: "freezePanes", sheet: "Sheet1", cell: "A2" },
      { kind: "setAutoFilter", sheet: "Sheet1", range: "A1:B1" },
      { kind: "setColumnWidth", sheet: "Sheet1", columns: "A:B", width: 18 },
      {
        kind: "addChart",
        sheet: "Sheet1",
        type: "column",
        at: "F2",
        series: [{ values: "A1:B1" }],
      },
    ]);
    const cells = await cellsOf(start.bytes);
    expect(cells.A1).toMatchObject({ value: "1,234.50", format: "#,##0.00" });
    expect(cells.B1).toMatchObject({ value: "25%" });
    const [sheet] = (await inspectSpreadsheet(start.bytes)).sheets;
    expect(sheet).toMatchObject({ frozenAt: "A2", filter: "A1:B1", merged: ["C1:D1"], charts: 1 });
    const preview = await previewSpreadsheet(start.bytes);
    const a1 = preview.cells.find((cell) => cell.row === 1 && cell.col === 1)!;
    expect(a1.value).toBe(1234.5);
    expect(preview.styles[a1.style!]).toMatchObject({ bold: true, numberFormat: "#,##0.00" });
    expect(preview.widths).toContainEqual([1, 18]);
    expect(preview).toMatchObject({ freeze: "A2", merges: ["C1:D1"] });
  });

  it("draws borders in the line and colour asked for, along one edge or around", async () => {
    const { bytes } = await edit(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          [1, 2],
          [3, 4],
        ],
      },
      { kind: "setFormat", sheet: "Sheet1", range: "A1:B1", border: "top", borderStyle: "dashed" },
      {
        kind: "setFormat",
        sheet: "Sheet1",
        range: "A2:B2",
        border: "bottom",
        borderStyle: "double",
        borderColor: "#C00000",
      },
    ]);
    const { cells, styles } = await previewSpreadsheet(bytes);
    const style = (row: number, column: number) => {
      const at = cells.find((cell) => cell.row === row && cell.col === column)?.style;
      return at === undefined ? undefined : styles[at];
    };
    expect(style(1, 2)).toEqual({ borderTop: { style: "dashed" } });
    expect(style(2, 1)).toEqual({ borderBottom: { style: "double", color: "#C00000" } });
  });

  it("follows a renamed sheet in formulas and names, and reports what a deleted one breaks", async () => {
    const base = await edit(await createSpreadsheet(), [
      { kind: "addSheet", name: "Other Sheet" },
      { kind: "setCells", sheet: "Other Sheet", start: "A1", rows: [[5]] },
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [["='Other Sheet'!A1*2", '="Other Sheet!A1"']],
      },
      { kind: "defineName", name: "Five", sheet: "Other Sheet", range: "A1" },
      { kind: "renameSheet", sheet: "Other Sheet", name: "Inputs" },
    ]);
    const cells = await cellsOf(base.bytes);
    expect(cells.A1).toMatchObject({ formula: "=Inputs!A1*2", value: "10" });
    // Text that merely looks like a reference is not a reference.
    expect(cells.B1).toMatchObject({ value: "Other Sheet!A1" });
    expect((await inspectSpreadsheet(base.bytes)).names[0]!.refersTo).toBe("Inputs!$A$1");
    const deleted = await edit(base.bytes, [{ kind: "deleteSheet", sheet: "Inputs" }]);
    expect(deleted.formulaErrors.count).toBeGreaterThan(0);
  });

  it("reports a circular reference and keeps the file's value for a function it lacks", async () => {
    const workbook = createWorkbook();
    const sheet = addWorksheet(workbook, "Sheet1");
    setCell(sheet, 1, 1, makeFormula("NOSUCHFUNCTION(1)", { cachedValue: 42 }));
    const bytes = await workbookToBytes(workbook);
    const result = await edit(bytes, [
      { kind: "setCells", sheet: "Sheet1", start: "B1", rows: [["=C1+1", "=B1+1"]] },
    ]);
    expect(result.formulaErrors.cells).toEqual(
      expect.arrayContaining([{ cell: "Sheet1!B1", error: "#CIRCULAR" }]),
    );
    expect(result.notCalculated).toEqual(["NOSUCHFUNCTION"]);
    expect((await cellsOf(result.bytes)).A1).toMatchObject({ value: "42" });
  });

  it("gives every member of a shared formula its own formula before editing", async () => {
    const workbook = createWorkbook();
    const sheet = addWorksheet(workbook, "Sheet1");
    for (let row = 1; row <= 3; row++) setCell(sheet, row, 1, row * 10);
    setCell(sheet, 1, 2, makeSharedFormula(0, "A1*2", "B1:B3"));
    setCell(sheet, 2, 2, makeSharedFormula(0));
    setCell(sheet, 3, 2, makeSharedFormula(0));
    const result = await edit(await workbookToBytes(workbook), [
      { kind: "setCells", sheet: "Sheet1", start: "A2", rows: [[100]] },
    ]);
    const cells = await cellsOf(result.bytes);
    expect(cells.B2).toMatchObject({ formula: "=A2*2", value: "200" });
    expect(cells.B3).toMatchObject({ formula: "=A3*2", value: "60" });
  });

  it("refuses writes into merged or array cells and macro-enabled workbooks", async () => {
    const merged = await edit(await createSpreadsheet(), [
      { kind: "mergeCells", sheet: "Sheet1", range: "A1:B1" },
    ]);
    await expect(
      edit(merged.bytes, [{ kind: "setCells", sheet: "Sheet1", start: "B1", rows: [["x"]] }]),
    ).rejects.toThrow(/inside merged range A1:B1/);
    await expect(
      edit(merged.bytes, [{ kind: "setCells", sheet: "Nope", start: "A1", rows: [[1]] }]),
    ).rejects.toThrow(/No sheet "Nope"; sheets: Sheet1/);
    const macros = createWorkbook();
    addWorksheet(macros, "Sheet1");
    macros.vbaProject = new Uint8Array([1, 2, 3]);
    await expect(inspectSpreadsheet(await workbookToBytes(macros))).rejects.toThrow(
      /Macro-enabled/,
    );
  });

  it("saves the values a chart plots, its names and a theme, as Excel does", async () => {
    const made = await edit(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Month", "Sales"],
          ["Jan", 120],
          ["Feb", "=B2*2"],
        ],
      },
      {
        kind: "addChart",
        sheet: "Sheet1",
        type: "column",
        at: "D2",
        categories: "Sheet1!A2:A3",
        series: [{ values: "Sheet1!B2:B3", name: "Sales" }],
      },
    ]);
    const files = unzipSync(made.bytes);
    const chart = strFromU8(files["xl/charts/chart1.xml"]!);
    // Text categories as text, computed values too; a literal name is the name alone.
    expect(chart).toContain("<c:tx><c:v>Sales</c:v></c:tx>");
    expect(chart).toMatch(
      /<c:strRef><c:f>Sheet1!\$A\$2:\$A\$3<\/c:f><c:strCache>.*<c:v>Jan<\/c:v>.*<c:v>Feb<\/c:v>/,
    );
    expect(chart).toMatch(/<c:numCache>.*<c:v>120<\/c:v>.*<c:v>240<\/c:v>/);
    expect(strFromU8(files["xl/theme/theme1.xml"]!)).toContain('<a:srgbClr val="4472C4"/>');
    // A later edit refreshes what the chart stored.
    const edited = await edit(made.bytes, [
      { kind: "setCells", sheet: "Sheet1", start: "B2", rows: [[50]] },
    ]);
    expect(strFromU8(unzipSync(edited.bytes)["xl/charts/chart1.xml"]!)).toMatch(
      /<c:numCache>.*<c:v>50<\/c:v>.*<c:v>100<\/c:v>/,
    );
    const preview = await previewSpreadsheet(edited.bytes);
    expect(preview).toMatchObject({ charts: [{ index: 0 }], otherCharts: 0 });
    const drawn = await previewChart(edited.bytes, undefined, 0);
    expect(drawn.chart).toContain("<c:v>100</c:v>");
    expect(drawn.width).toBeGreaterThan(drawn.height);
    await expect(previewChart(edited.bytes, undefined, 1)).rejects.toThrow(
      /Chart 2 does not exist/,
    );
    // A chart saved without its values (as this app once did: data references
    // bare, only the series name kept) is drawn from the cells as they are.
    const bare = unzipSync(edited.bytes);
    bare["xl/charts/chart1.xml"] = strToU8(
      strFromU8(bare["xl/charts/chart1.xml"]!)
        .replace(
          /(<c:(?:num|str)Ref><c:f>[^<]+<\/c:f>)<c:(num|str)Cache>[\s\S]*?<\/c:\2Cache>/g,
          "$1",
        )
        .replace(
          "<c:tx><c:v>Sales</c:v></c:tx>",
          '<c:tx><c:strRef><c:f></c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>',
        ),
    );
    expect(strFromU8(bare["xl/charts/chart1.xml"]!)).not.toContain("<c:v>100</c:v>");
    expect((await previewChart(zipSync(bare), undefined, 0)).chart).toContain("<c:v>100</c:v>");
  });

  it("keeps a series name read from a cell, as Excel stores it, across an edit", async () => {
    const made = await edit(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["Month", "Sales"],
          ["Jan", 1],
        ],
      },
      {
        kind: "addChart",
        sheet: "Sheet1",
        type: "column",
        at: "D2",
        categories: "Sheet1!A2:A2",
        series: [{ values: "Sheet1!B2:B2", name: "Sales" }],
      },
    ]);
    // As Excel writes it: the name is the cell B1, with its text kept beside it.
    const files = unzipSync(made.bytes);
    files["xl/charts/chart1.xml"] = strToU8(
      strFromU8(files["xl/charts/chart1.xml"]!).replace(
        "<c:tx><c:v>Sales</c:v></c:tx>",
        '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>',
      ),
    );
    const edited = await edit(zipSync(files), [
      { kind: "setCells", sheet: "Sheet1", start: "B1", rows: [["Revenue & tax"]] },
    ]);
    expect(strFromU8(unzipSync(edited.bytes)["xl/charts/chart1.xml"]!)).toContain(
      '<c:tx><c:strRef><c:f>Sheet1!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Revenue &amp; tax</c:v>',
    );
  });

  it("clips a merge to the preview window", async () => {
    const made = await edit(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [
          ["x", "y"],
          [1, 2],
        ],
      },
    ]);
    // "Select all, merge" in Excel: written into the file, not run through an edit.
    const files = unzipSync(made.bytes);
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!).replace(
        "</sheetData>",
        '</sheetData><mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>',
      ),
    );
    // Sent as written; the grid clips it to what it draws.
    expect((await previewSpreadsheet(zipSync(files))).merges).toEqual(["A1:XFD1048576"]);
  });

  it("keeps series names across edits, which the chart library does not read", async () => {
    let bytes = (
      await edit(await createSpreadsheet(), [
        {
          kind: "setCells",
          sheet: "Sheet1",
          start: "A1",
          rows: [
            ["Month", "Sales"],
            ["Jan", 1],
          ],
        },
        {
          kind: "addChart",
          sheet: "Sheet1",
          type: "line",
          at: "D2",
          categories: "Sheet1!A2:A2",
          series: [{ values: "Sheet1!B2:B2", name: "Sales" }],
        },
      ])
    ).bytes;
    for (const value of [2, 3])
      bytes = (
        await edit(bytes, [{ kind: "setCells", sheet: "Sheet1", start: "B2", rows: [[value]] }])
      ).bytes;
    expect(strFromU8(unzipSync(bytes)["xl/charts/chart1.xml"]!)).toContain(
      "<c:tx><c:v>Sales</c:v></c:tx>",
    );
  });

  it("finds a chart whatever prefix its drawing's namespace has", async () => {
    const made = await edit(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["Jan", 1]] },
      {
        kind: "addChart",
        sheet: "Sheet1",
        type: "column",
        at: "D2",
        categories: "Sheet1!A1:A1",
        series: [{ values: "Sheet1!B1:B1" }],
      },
    ]);
    // The same drawing under another namespace prefix, as some writers emit it.
    const files = unzipSync(made.bytes);
    files["xl/drawings/drawing1.xml"] = strToU8(
      strFromU8(files["xl/drawings/drawing1.xml"]!)
        .replaceAll("xdr:", "sd:")
        .replace("xmlns:xdr=", "xmlns:sd="),
    );
    expect(await previewSpreadsheet(zipSync(files))).toMatchObject({
      charts: [{ index: 0, row: 2, col: 4 }],
      otherCharts: 0,
    });
    // And with none, as openpyxl writes it.
    files["xl/drawings/drawing1.xml"] = strToU8(
      strFromU8(files["xl/drawings/drawing1.xml"]!)
        .replaceAll("sd:", "")
        .replace("xmlns:sd=", "xmlns="),
    );
    expect(await previewSpreadsheet(zipSync(files))).toMatchObject({ charts: [{ index: 0 }] });
  });

  it("checks a package like every Office file before the library parses it", async () => {
    const files = unzipSync(await createSpreadsheet());
    await expect(
      inspectSpreadsheet(zipSync({ ...files, "../outside.xml": strToU8("<x/>") })),
    ).rejects.toThrow(/not a workbook/);
    const ratio = zipSync(
      { ...files, "xl/media/zeros.bin": new Uint8Array(4 * 1024 * 1024) },
      { level: 9 },
    );
    await expect(inspectSpreadsheet(ratio)).rejects.toThrow(/expands past/);
  });

  it("saves a spilling formula as Excel 365 does, and keeps it dynamic across edits", async () => {
    const created = await createSpreadsheet();
    const first = await edit(created, [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[3], [1], [2]] },
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "C1",
        rows: [["=SORT(A1:A3)", "=FILTER(A1:A3,A1:A3>5)"]],
      },
    ]);
    const files = unzipSync(first.bytes);
    expect(strFromU8(files["xl/metadata.xml"]!)).toContain('name="XLDAPR"');
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toMatch(/<c r="C1"[^>]* cm="1"/);
    // FILTER found nothing: #CALC! can't be stored as a plain cached error, so none is.
    expect(sheet).not.toContain("#CALC!");
    expect(first.formulaErrors.cells).toContainEqual({ cell: "Sheet1!D1", error: "#CALC!" });
    const cells = await cellsOf(first.bytes, "Sheet1", "C1:C3");
    expect([cells.C1?.value, cells.C2?.value, cells.C3?.value]).toEqual(["1", "2", "3"]);

    // An unrelated edit keeps the mark, since it is read back from the file.
    const second = await edit(first.bytes, [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[9]] },
    ]);
    expect(strFromU8(unzipSync(second.bytes)["xl/worksheets/sheet1.xml"]!)).toMatch(
      /<c r="C1"[^>]* cm="1"/,
    );
    const resorted = await cellsOf(second.bytes, "Sheet1", "C1:C3");
    expect([resorted.C1?.value, resorted.C2?.value, resorted.C3?.value]).toEqual(["1", "2", "9"]);

    // Writing into the spill is allowed; the formula then shows #SPILL!.
    const blocked = await edit(second.bytes, [
      { kind: "setCells", sheet: "Sheet1", start: "C3", rows: [["mine"]] },
    ]);
    expect(blocked.formulaErrors.cells).toContainEqual({ cell: "Sheet1!C1", error: "#SPILL!" });
    expect((await cellsOf(blocked.bytes, "Sheet1", "C3:C3")).C3?.value).toBe("mine");
  });

  it("spells out Excel 365 shorthands in the file and reads a spill by reference", async () => {
    const edited = await edit(await createSpreadsheet(), [
      {
        kind: "setCells",
        sheet: "Sheet1",
        start: "A1",
        rows: [["=SEQUENCE(3)", "=SUM(A1#)", "=@A1:A3", "=MAP(A1:A3,LAMBDA(x,x*2))"]],
      },
    ]);
    const sheet = strFromU8(unzipSync(edited.bytes)["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("SUM(_xlfn.ANCHORARRAY(A1))");
    expect(sheet).toContain("_xlfn.SINGLE(A1:A3)");
    expect(sheet).toContain("_xlfn.MAP(A1:A3,_xlfn.LAMBDA(_xlpm.x,_xlpm.x*2))");
    // MAP isn't calculated here, but it still spills in Excel, so it is saved dynamic.
    expect(sheet).toMatch(/<c r="D1"[^>]* cm="1"/);
    const cells = await cellsOf(edited.bytes, "Sheet1", "B1:C1");
    expect([cells.B1?.value, cells.C1?.value]).toEqual(["6", "1"]);
  });

  it("drops Excel's calculation chain, which an edit can leave naming removed cells", async () => {
    const saved = new Uint8Array(
      readFileSync(new URL("../../../../tests/fixtures/excel-parity.xlsx", import.meta.url)),
    );
    expect(Object.keys(unzipSync(saved))).toContain("xl/calcChain.xml");
    const edited = await edit(saved, [{ kind: "clearRange", sheet: "Legacy", range: "B1" }]);
    const files = unzipSync(edited.bytes);
    expect(Object.keys(files)).not.toContain("xl/calcChain.xml");
    expect(strFromU8(files["xl/_rels/workbook.xml.rels"]!)).not.toContain("calcChain");
    expect(strFromU8(files["[Content_Types].xml"]!)).not.toContain("calcChain");
  });
});
