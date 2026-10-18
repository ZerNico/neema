import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readOfficePackage } from "./package.ts";

const limits = {
  archiveBytes: 1024 * 1024,
  entries: 100,
  entryBytes: 1024 * 1024,
  expandedBytes: 1024 * 1024,
  expansionRatio: 1000,
};

/** The kind of refusal the reader gives a package, or null when it accepts it. */
const refusal = (parts: Record<string, string>, override = "") => {
  const types = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${override}</Types>`;
  const files = Object.fromEntries(
    Object.entries({ "[Content_Types].xml": types, ...parts }).map(([name, text]) => [
      name,
      strToU8(text),
    ]),
  );
  try {
    readOfficePackage(zipSync(files), {
      limits,
      fail: (kind) => {
        throw new Error(kind);
      },
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe("readOfficePackage active content", () => {
  it("refuses macros, controls and objects by part name, in any format", () => {
    expect(refusal({ "xl/vbaProject.bin": "x" })).toBe("macros");
    expect(refusal({ "xl/activeX/activeX1.xml": "<x/>" })).toBe("objects");
    expect(refusal({ "ppt/embeddings/oleObject1.bin": "x" })).toBe("objects");
  });

  it("refuses a macro-enabled file renamed to the plain extension", () => {
    expect(
      refusal(
        {},
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>',
      ),
    ).toBe("macros");
  });

  it("keeps a chart's embedded workbook, which is data", () => {
    expect(refusal({ "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx": "x" })).toBeNull();
  });
});
