import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createWorkbook } from "@office-kit/xlsx/workbook";
import { describe, expect, it } from "vitest";
import { createSpreadsheet, editSpreadsheet } from "./adapter.ts";
import { fileColors } from "./file-colors.ts";
import { previewSpreadsheet } from "./preview.ts";

const cell = (preview: Awaited<ReturnType<typeof previewSpreadsheet>>, ref: [number, number]) =>
  preview.cells.find((each) => each.row === ref[0] && each.col === ref[1]);

describe("spreadsheet preview", () => {
  it("shows the result a file stored, not one calculated again", async () => {
    const { bytes } = await editSpreadsheet(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[2, "=A1*10", "=1/0"]] },
    ]);
    // Another program saved 99 as B1's result; the preview shows what it saved.
    const files = unzipSync(bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    files["xl/worksheets/sheet1.xml"] = strToU8(
      sheet.replace(/(<c r="B1"[^>]*>\s*<f>[^<]*<\/f>\s*<v>)20(<\/v>)/, "$199$2"),
    );
    const preview = await previewSpreadsheet(zipSync(files));
    expect(cell(preview, [1, 2])).toMatchObject({ value: 99, formula: "=A1*10" });
    expect(cell(preview, [1, 3])).toMatchObject({ value: { error: "#DIV/0!" }, formula: "=1/0" });
  });

  it("calculates only the results a file left out, keeping the ones it stored", async () => {
    const { bytes } = await editSpreadsheet(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[2, "=A1*10", "=1+1"]] },
    ]);
    // B1 was saved as 99 by another program, C1 with no result at all.
    const files = unzipSync(bytes);
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!)
      .replace(/(<c r="B1"[^>]*>\s*<f>[^<]*<\/f>\s*<v>)20(<\/v>)/, "$199$2")
      .replace(/(<c r="C1"[^>]*>\s*<f>[^<]*<\/f>)\s*<v>2<\/v>/, "$1");
    expect(sheet).not.toMatch(/<c r="C1"[^>]*>\s*<f>[^<]*<\/f>\s*<v>/);
    files["xl/worksheets/sheet1.xml"] = strToU8(sheet);
    const preview = await previewSpreadsheet(zipSync(files));
    expect(cell(preview, [1, 2])).toMatchObject({ value: 99 });
    expect(cell(preview, [1, 3])).toMatchObject({ value: 2, formula: "=1+1" });
  });

  it("keeps hidden sheets out of sight and names the rows and columns a sheet hides", async () => {
    const { bytes } = await editSpreadsheet(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [["a"], ["b"], ["c"]] },
      { kind: "addSheet", name: "Secret" },
    ]);
    // Hidden in Excel: written into the file, as no edit hides anything.
    const files = unzipSync(bytes);
    files["xl/worksheets/sheet1.xml"] = strToU8(
      strFromU8(files["xl/worksheets/sheet1.xml"]!)
        .replace(/<row r="2"/, '<row r="2" hidden="1"')
        .replace(
          "<sheetData>",
          '<cols><col min="3" max="3" width="9" hidden="1"/></cols><sheetData>',
        ),
    );
    files["xl/workbook.xml"] = strToU8(
      strFromU8(files["xl/workbook.xml"]!).replace(
        /<sheet name="Secret"/,
        '<sheet name="Secret" state="hidden"',
      ),
    );
    const preview = await previewSpreadsheet(zipSync(files));
    expect(preview.sheets).toEqual([{ name: "Sheet1" }, { name: "Secret", hidden: true }]);
    expect(preview).toMatchObject({ hiddenRows: [2], hiddenCols: [3] });
  });

  it("moves a 1904-system workbook's dates onto the calendar the grid counts from", async () => {
    const { bytes } = await editSpreadsheet(await createSpreadsheet(), [
      { kind: "setCells", sheet: "Sheet1", start: "A1", rows: [[1, 1]] },
      { kind: "setFormat", sheet: "Sheet1", range: "A1", numberFormat: "yyyy-mm-dd" },
    ]);
    const files = unzipSync(bytes);
    const workbook = strFromU8(files["xl/workbook.xml"]!);
    files["xl/workbook.xml"] = strToU8(
      workbook.includes("<workbookPr")
        ? workbook.replace("<workbookPr", '<workbookPr date1904="1"')
        : workbook.replace("<sheets>", '<workbookPr date1904="1"/><sheets>'),
    );
    const preview = await previewSpreadsheet(zipSync(files));
    // Day 1 of 1904 is 1904-01-02, which the 1900 calendar numbers 1463; a plain number stays.
    expect(cell(preview, [1, 1])?.value).toBe(1463);
    expect(cell(preview, [1, 2])?.value).toBe(1);
  });

  it("reads theme colours with their tint, as Excel draws them", () => {
    const colorOf = fileColors(createWorkbook());
    // Excel numbers the light and dark pairs the other way round from the theme.
    expect(colorOf({ theme: 0 })).toBe("#FFFFFF");
    expect(colorOf({ theme: 1, tint: 0.5 })).toBe("#808080");
    expect(colorOf({ theme: 4 })).toBe("#4472C4");
    expect(colorOf({ theme: 4, tint: -0.25 })).toBe("#2F5597");
    expect(colorOf({ indexed: 2 })).toBe("#FF0000");
    expect(colorOf({ rgb: "FF00B050" })).toBe("#00B050");
    expect(colorOf({ auto: true })).toBeNull();
  });
});
