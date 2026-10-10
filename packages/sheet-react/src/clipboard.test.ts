import { describe, expect, it } from "vitest";
import { DE_DE, EN_US } from "@chat/sheet/locales";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { emptyDoc, positions, type SheetDoc } from "@chat/sheet/model";
import type { SheetOp } from "@chat/sheet/model/ops";
import { readHtmlTable, selectionHtml } from "./clipboard.ts";
import { formatSelection, pasteAtSelection, type GridContext } from "./commands.ts";

let revision = 0;
const apply = (doc: SheetDoc, ops: readonly SheetOp[]) =>
  applyChange(doc, { clientId: "t", seq: ++revision, ops }, revision).doc;
const at = (doc: SheetDoc, row: number, col: number) => ({
  r: positions(doc.sheet.s1!.rows).ids[row - 1]!,
  c: positions(doc.sheet.s1!.cols).ids[col - 1]!,
});
let minted = 0;
const context = (
  doc: SheetDoc,
  from: [number, number],
  to: [number, number] = from,
  locale = EN_US,
): GridContext => ({
  doc,
  sheet: "s1",
  selection: { anchor: at(doc, ...from), head: at(doc, ...to) },
  values: calculateSheet(doc, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
  locale,
  mint: () => `n${++minted}`,
});
const cell = (doc: SheetDoc, row: number, col: number) => {
  const { r, c } = at(doc, row, col);
  return doc.sheet.s1!.cells[r]?.[c];
};

// Shaped as Excel for Mac and Windows put a copied range on the clipboard.
const EXCEL = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><style><!--
td {padding-top:1px; color:black; font-size:11.0pt; font-family:Calibri, sans-serif; vertical-align:bottom;}
.xl65 {mso-style-parent:style0; font-weight:700; background:#FFFF00; mso-pattern:black none;}
.xl66 {mso-style-parent:style0; mso-number-format:"\\0022$\\0022\\#\\,\\#\\#0\\.00"; color:#C00000;}
.xl67 {mso-style-parent:style0; mso-number-format:Percent; border-bottom:.5pt solid windowtext;}
--></style></head>
<body><table>
<tr><td class=xl65>Region</td><td class=xl66 align=right x:num="1234.5">$1,234.50</td></tr>
<tr><td colspan=2 style="font-style:italic">North
  and south</td></tr>
<tr><td>Line one<br style="mso-data-placement:same-cell;">line two</td><td class=xl67 x:num="0.25">25.00%</td></tr>
</table></body></html>`;

// Shaped as Google Sheets puts a copied range on the clipboard.
const SHEETS = `<meta charset="utf-8"><google-sheets-html-origin><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none"><colgroup><col width="100"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;font-family:Georgia;font-weight:bold;color:#1155cc;text-align:center;">Total</td><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;background-color:rgb(217, 234, 211);text-align:right;" data-sheets-value="{&quot;1&quot;:3,&quot;3&quot;:42}">42</td></tr></tbody></table>`;

describe("HTML on the clipboard", () => {
  it("reads Excel's classes, number marks, merged cells and in-cell breaks", () => {
    const read = readHtmlTable(EXCEL)!;
    expect(read).toHaveLength(3);
    expect(read[0]![0]).toEqual({
      raw: "Region",
      style: { bold: true, fill: "#FFFF00" },
    });
    expect(read[0]![1]).toEqual({
      raw: "$1,234.50",
      value: 1234.5,
      style: { fontColor: "#C00000", numberFormat: '"$"#,##0.00' },
    });
    // A merged cell's text collapses its source line break, and the place it covers is empty.
    expect(read[1]!.map((each) => each.raw)).toEqual(["North and south", ""]);
    expect(read[1]![0]!.style).toEqual({ italic: true });
    expect(read[2]![0]!.raw).toBe("Line one\nline two");
    expect(read[2]![1]).toMatchObject({
      value: 0.25,
      style: { numberFormat: "0.00%", borderBottom: true },
    });
  });

  it("reads Google Sheets' inline styles and values, leaving out its defaults", () => {
    const read = readHtmlTable(SHEETS)!;
    expect(read).toEqual([
      [
        {
          raw: "Total",
          style: { bold: true, fontFamily: "Georgia", fontColor: "#1155CC", horizontal: "center" },
        },
        { raw: "42", value: 42, style: { fill: "#D9EAD3", horizontal: "right" } },
      ],
    ]);
    expect(readHtmlTable("<p>no table</p>")).toBeNull();
    // A script address is never taken for a link.
    expect(
      readHtmlTable('<table><tr><td><a href="javascript:alert(1)">x</a></td></tr></table>')![0]![0]!
        .style,
    ).toEqual({});
  });

  it("pastes another program's cells with their styles, numbers as numbers in any locale", () => {
    const foreign = readHtmlTable(EXCEL);
    const doc = apply(
      emptyDoc(),
      pasteAtSelection(context(emptyDoc(), [1, 1], [1, 1], DE_DE), "ignored", null, { foreign }),
    );
    expect(cell(doc, 1, 1)).toMatchObject({ v: "Region", s: '{"bold":true,"fill":"#FFFF00"}' });
    expect(cell(doc, 1, 2)!.v).toBe(1234.5);
    expect(cell(doc, 3, 1)!.v).toBe("Line one\nline two");
  });

  it("writes the selection as a table each program reads back with its looks", () => {
    let doc = apply(emptyDoc(), [
      {
        op: "set",
        sh: "s1",
        cells: [
          { ...at(emptyDoc(), 1, 1), v: "A & <b>" },
          { ...at(emptyDoc(), 1, 2), v: 0.5 },
        ],
      },
    ]);
    doc = apply(
      doc,
      formatSelection(context(doc, [1, 1]), {
        bold: true,
        fill: "#DDEBF7",
        link: "https://example.com/a?b=1&c=2",
      }),
    );
    doc = apply(doc, formatSelection(context(doc, [1, 2]), { numberFormat: "0%" }));
    const html = selectionHtml(context(doc, [1, 1], [1, 2]));
    expect(html).toContain("A &amp; &lt;b&gt;");
    expect(html).toContain('x:num="0.5"');
    expect(readHtmlTable(html)).toEqual([
      [
        {
          raw: "A & <b>",
          style: { bold: true, fill: "#DDEBF7", link: "https://example.com/a?b=1&c=2" },
        },
        { raw: "50%", value: 0.5, style: { numberFormat: "0%" } },
      ],
    ]);
  });
});
