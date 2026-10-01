import { describe, expect, it } from "vitest";
import { OFFICE_THEME_XML } from "../../spreadsheets/server/office-theme.ts";
import { forSlide, renderWorkbookChart } from "./chart-render.ts";

const chart = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>Sales</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$3</c:f><c:strCache><c:ptCount val="2"/><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>Sheet1!$B$2:$B$3</c:f><c:numCache><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:scaling/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:scaling/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;

describe("workbook charts drawn by the slide renderer", () => {
  it("reads a literal series name and drops the links to the workbook", () => {
    const xml = forSlide(chart);
    expect(xml).toContain('<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>Sales</c:v>');
    expect(xml).not.toContain("externalData");
  });

  it("draws a chart at its own proportions", async () => {
    const png = await renderWorkbookChart({
      chart,
      theme: OFFICE_THEME_XML,
      width: 360,
      height: 216,
    });
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const view = new DataView(png.buffer, png.byteOffset);
    // A PNG's width and height follow its signature and header chunk.
    expect(view.getUint32(16) / view.getUint32(20)).toBeCloseTo(360 / 216, 1);
  });
});
