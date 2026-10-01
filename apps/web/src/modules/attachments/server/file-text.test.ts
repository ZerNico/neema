import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { fileText } from "./file-text.ts";

const office = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const types = { "[Content_Types].xml": "<Types/>" };

describe("fileText", () => {
  it("reads slides in order, paragraph by paragraph, decoding entities", () => {
    const deck = office({
      ...types,
      "ppt/presentation.xml": "<p/>",
      "ppt/slides/slide10.xml": "<a:p><a:r><a:t>Last</a:t></a:r></a:p>",
      "ppt/slides/slide2.xml":
        "<a:p><a:r><a:t>Q3 &amp; Q4</a:t></a:r></a:p><a:p><a:r><a:t>Revenue</a:t></a:r><a:r><a:t> up</a:t></a:r></a:p>",
    });
    expect(fileText("deck.pptx", deck)).toBe(
      "## Slide 2\nQ3 & Q4\nRevenue up\n\n## Slide 10\nLast",
    );
  });

  it("reads a document's paragraphs and a workbook's cells, shared strings included", () => {
    const document = office({
      ...types,
      "word/document.xml":
        '<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t></w:r></w:p>',
    });
    expect(fileText("brief.docx", document)).toBe("Hello world\nNext");
    const workbook = office({
      ...types,
      "xl/workbook.xml": '<sheets><sheet name="Budget" sheetId="1"/></sheets>',
      "xl/sharedStrings.xml": "<sst><si><t>Item</t></si><si><t>Cost</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Venue</t></is></c><c r="B2"><v>1200</v></c></row>',
    });
    expect(fileText("budget.xlsx", workbook)).toBe("## Budget\nItem\tCost\nVenue\t1200");
  });

  it("gives up on an entry that expands far beyond its compressed size", () => {
    const bomb = office({ ...types, "word/document.xml": "a".repeat(20_000_000) });
    expect(fileText("bomb.docx", bomb)).toBeNull();
  });

  it("reads an SVG's source, and nothing from bytes that only claim to be one", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Q3</text></svg>';
    expect(fileText("chart.svg", new TextEncoder().encode(svg))).toBe(svg);
    expect(fileText("chart.svg", new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(fileText("chart.svg", new TextEncoder().encode("plain words"))).toBeNull();
  });

  it("has nothing to say about a file it has no reader for", () => {
    expect(fileText("tool.exe", new Uint8Array([0x4d, 0x5a]))).toBeNull();
    expect(fileText("deck.pptx", strToU8("not a zip"))).toBeNull();
  });
});
