import { describe, expect, it } from "vitest";
import { addWorksheet, createWorkbook } from "@office-kit/xlsx/workbook";
import { setColumnWidth, setRowHeight } from "@office-kit/xlsx/worksheet";
import { anchorSize } from "./file-anchors.ts";

describe("a drawing's size in a file", () => {
  it("spans the sheet's own column widths and row heights between its two cells", () => {
    const sheet = addWorksheet(createWorkbook(), "Sheet1");
    setColumnWidth(sheet, 1, 20);
    setRowHeight(sheet, 2, 30);
    const corner = (col: number, row: number) => ({ col, row, colOff: 0, rowOff: 0 });
    const anchor = { kind: "twoCell" as const, from: corner(0, 0), to: corner(2, 2) };
    // A at 20 characters (145px) and B at the default 64px; row 1 at 20px, row 2 at 30pt (40px).
    expect(anchorSize(sheet, anchor)).toEqual([209, 60]);
  });
});
