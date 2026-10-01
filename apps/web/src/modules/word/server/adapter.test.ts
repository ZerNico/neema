import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  addStyle,
  createDocx,
  openDocx,
  paragraphText,
  toUint8Array,
  validate,
} from "@office-kit/docx";
import { describe, expect, it } from "vitest";
import { WordError } from "../errors.ts";
import { parseWordOperations } from "../operations.ts";
import {
  createWordFile,
  editWordFile,
  inlineRuns,
  inspectWordFile,
  previewWordFile,
} from "./adapter.ts";

const documentXml = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["word/document.xml"]!);

describe("Word adapter", () => {
  it("builds a document from headings, formatted text, lists and a table", () => {
    const edited = editWordFile(createWordFile(), [
      { kind: "removeBlocks", blocks: [0] },
      {
        kind: "insertParagraphs",
        at: "end",
        paragraphs: [
          { text: "Quarterly report", style: "title" },
          { text: "Summary", style: "heading1" },
          { text: "Revenue grew **12%**, driven by *new* customers.", align: "justify" },
          { text: "North", list: "bullet" },
          { text: "Coast", list: "bullet", level: 1 },
          { text: "First step", list: "numbered" },
        ],
      },
      {
        kind: "insertTable",
        at: "end",
        rows: [
          ["Region", "Revenue"],
          ["North", "120"],
        ],
      },
      { kind: "setTitle", title: "Q3" },
    ]);
    expect(edited.results).toEqual([
      { operation: 1, blocks: "0-5" },
      { operation: 2, blocks: "6" },
    ]);
    // Word needs a paragraph after a closing table; one is added.
    expect(edited.blockCount).toBe(8);
    expect(validate(openDocx(edited.bytes)).filter((issue) => issue.level === "error")).toEqual([]);

    const inspection = inspectWordFile(edited.bytes);
    expect(inspection.title).toBe("Q3");
    expect(inspection.outline).toEqual([{ block: 1, level: 1, text: "Summary" }]);
    expect(inspection.blocks.slice(0, 7)).toEqual([
      expect.objectContaining({ block: 0, role: "title", text: "Quarterly report" }),
      expect.objectContaining({ block: 1, role: "heading", level: 1 }),
      expect.objectContaining({
        block: 2,
        role: "body",
        text: "Revenue grew 12%, driven by new customers.",
      }),
      expect.objectContaining({ block: 3, role: "list", level: 0, text: "North" }),
      expect.objectContaining({ block: 4, role: "list", level: 1, text: "Coast" }),
      expect.objectContaining({ block: 5, role: "list", level: 0, text: "First step" }),
      expect.objectContaining({
        block: 6,
        type: "table",
        rowCount: 2,
        columnCount: 2,
        rows: [
          ["Region", "Revenue"],
          ["North", "120"],
        ],
      }),
    ]);
    const preview = previewWordFile(edited.bytes);
    expect(preview.blocks[2]).toEqual({
      type: "paragraph",
      role: "body",
      align: "both",
      runs: [
        { text: "Revenue grew " },
        { text: "12%", bold: true },
        { text: ", driven by " },
        { text: "new", italic: true },
        { text: " customers." },
      ],
    });
  });

  it("numbers blocks as the revision had them, whatever the call did before", () => {
    const start = editWordFile(createWordFile(), [
      {
        kind: "insertParagraphs",
        at: "start",
        paragraphs: [{ text: "A" }, { text: "B" }, { text: "C" }],
      },
    ]);
    const texts = (bytes: Uint8Array) =>
      inspectWordFile(bytes)
        .blocks.map((item) => item.text as string)
        .filter(Boolean);
    expect(texts(start.bytes)).toEqual(["A", "B", "C"]);
    const next = editWordFile(start.bytes, [
      { kind: "insertParagraphs", before: 0, paragraphs: [{ text: "Top" }] },
      { kind: "removeBlocks", blocks: [1] },
      { kind: "insertParagraphs", after: 2, paragraphs: [{ text: "After C" }] },
      { kind: "setParagraph", block: 0, text: "**A!**" },
    ]);
    expect(texts(next.bytes)).toEqual(["Top", "A!", "C", "After C"]);
    expect(() =>
      editWordFile(start.bytes, [
        { kind: "removeBlocks", blocks: [1] },
        { kind: "setParagraph", block: 1, text: "gone" },
      ]),
    ).toThrow(/block 1 was removed earlier in this call/);
    expect(() =>
      editWordFile(start.bytes, [{ kind: "setParagraph", block: 40, text: "x" }]),
    ).toThrow(/there is no block 40/);
  });

  it("fills a template's placeholders, even split across runs", () => {
    const template = createDocx({ paragraphs: [] });
    const bytes = toUint8Array(template);
    const files = unzipSync(bytes);
    // Word often splits "{{name}}" over runs, as editing history leaves it.
    files["word/document.xml"] = strToU8(
      documentXml(bytes).replace(
        "<w:body/>",
        '<w:body><w:p><w:r><w:t xml:space="preserve">Dear {{na</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>me}},</w:t></w:r></w:p></w:body>',
      ),
    );
    const edited = editWordFile(zipSync(files), [
      { kind: "replaceText", find: "{{name}}", replace: "Ada" },
    ]);
    expect(edited.results).toEqual([{ operation: 0, replaced: 1 }]);
    expect(paragraphText(openDocx(edited.bytes).document.body.blocks[0] as never)).toBe(
      "Dear Ada,",
    );
    expect(inspectWordFile(zipSync(files)).placeholders).toEqual(["{{name}}"]);
    expect(() =>
      editWordFile(edited.bytes, [{ kind: "replaceText", find: "{{name}}", replace: "x" }]),
    ).toThrow(/was not found/);
  });

  it("edits tables by cell and row", () => {
    const made = editWordFile(createWordFile(), [
      {
        kind: "insertTable",
        at: "start",
        rows: [
          ["A", "B"],
          ["1", "2"],
        ],
      },
    ]);
    const edited = editWordFile(made.bytes, [
      { kind: "setTableCell", table: 0, row: 1, column: 1, text: "two" },
      {
        kind: "addTableRows",
        table: 0,
        rows: [
          ["3", "4"],
          ["5", "6"],
        ],
      },
      { kind: "removeTableRows", table: 0, rows: [2] },
    ]);
    expect(inspectWordFile(edited.bytes).blocks[0]).toMatchObject({
      rows: [
        ["A", "B"],
        ["1", "two"],
        ["5", "6"],
      ],
    });
    expect(() =>
      editWordFile(made.bytes, [{ kind: "addTableRows", table: 0, rows: [["x"]] }]),
    ).toThrow(/give rows of 2/);
    expect(() =>
      editWordFile(made.bytes, [{ kind: "setTableCell", table: 1, row: 0, column: 0, text: "x" }]),
    ).toThrow(/block 1 is not a table/);
  });

  it("refuses macros, embedded objects and packages that expand past the bound", () => {
    const files = unzipSync(createWordFile());
    const withMacros = zipSync({ ...files, "word/vbaProject.bin": new Uint8Array([1, 2, 3]) });
    expect(() => inspectWordFile(withMacros)).toThrow(/Macro-enabled/);
    const embedded = zipSync({ ...files, "word/embeddings/oleObject1.bin": new Uint8Array([1]) });
    expect(() => inspectWordFile(embedded)).toThrow(/embedded objects/);
    // Highly compressible: tiny on disk, past the per-part bound once inflated.
    const bomb = zipSync(
      { ...files, "word/media/big.bin": new Uint8Array(70 * 1024 * 1024) },
      { level: 9 },
    );
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(() => inspectWordFile(bomb)).toThrow(/expands past/);
    expect(() => inspectWordFile(new Uint8Array([1, 2, 3]))).toThrow(WordError);
  });

  it("checks a package like every Office file: part names and expansion ratio", () => {
    const files = unzipSync(createWordFile());
    const escaping = zipSync({ ...files, "../outside.xml": strToU8("<x/>") });
    expect(() => inspectWordFile(escaping)).toThrow(/not a Word file/);
    // Within every byte bound, but 2 MiB from a few KiB of zeros is no document.
    const ratio = zipSync(
      { ...files, "word/media/zeros.bin": new Uint8Array(2 * 1024 * 1024) },
      { level: 9 },
    );
    expect(() => inspectWordFile(ratio)).toThrow(/expands past/);
    const many = Object.fromEntries(
      Array.from({ length: 2_001 }, (_, index) => [`word/media/p${index}.bin`, new Uint8Array(1)]),
    );
    expect(() => inspectWordFile(zipSync({ ...files, ...many }))).toThrow(/at most 2000 parts/);
  });

  it("validates operations before any file is opened", () => {
    expect(() =>
      parseWordOperations([{ kind: "insertParagraphs", paragraphs: [{ text: "x" }] }]),
    ).toThrow(/exactly one of before, after or at/);
    expect(() =>
      parseWordOperations([{ kind: "insertTable", at: "end", rows: [["a", "b"], ["c"]] }]),
    ).toThrow(/same number of cells/);
    expect(() =>
      parseWordOperations([{ kind: "replaceText", find: "a", replace: "b\nc" }]),
    ).toThrow(/no newlines/);
    // A flat row and a style in another case are near misses worth accepting.
    expect(
      parseWordOperations([
        { kind: "insertTable", at: "end", rows: ["a", "b"] },
        { kind: "insertParagraphs", at: "end", paragraphs: [{ text: "x", style: "Heading2" }] },
      ]),
    ).toEqual([
      { kind: "insertTable", at: "end", rows: [["a", "b"]] },
      { kind: "insertParagraphs", at: "end", paragraphs: [{ text: "x", style: "heading2" }] },
    ]);
  });

  it("reads inline markup, with escapes", () => {
    expect(inlineRuns("a **b *c* d** \\*d\\* `e`")).toEqual([
      { text: "a ", format: {} },
      { text: "b ", format: { bold: true } },
      { text: "c", format: { bold: true, italic: true } },
      { text: " d", format: { bold: true } },
      { text: " ", format: {} },
      { text: "*", format: {} },
      { text: "d", format: {} },
      { text: "*", format: {} },
      { text: " ", format: {} },
      { text: "e", format: { font: "Consolas" } },
    ]);
  });

  it("fills placeholders in table cells too, and lists them", () => {
    const made = editWordFile(createWordFile(), [
      {
        kind: "insertTable",
        at: "start",
        rows: [
          ["Name", "Total"],
          ["{{client}}", "{{total}}"],
        ],
      },
    ]);
    expect(inspectWordFile(made.bytes).placeholders).toEqual(["{{client}}", "{{total}}"]);
    const filled = editWordFile(made.bytes, [
      { kind: "replaceText", find: "{{client}}", replace: "Ada" },
    ]);
    expect(filled.results).toEqual([{ operation: 0, replaced: 1 }]);
    expect(inspectWordFile(filled.bytes).blocks[0]).toMatchObject({
      rows: [
        ["Name", "Total"],
        ["Ada", "{{total}}"],
      ],
    });
  });

  it("refuses a package whose central directory declares more than its parts hold", () => {
    const bytes = createWordFile();
    // The parser allocates the size the central directory declares; forge one past the bound.
    const forged = bytes.slice();
    const view = new DataView(forged.buffer);
    let at = forged.length - 22;
    while (view.getUint32(at, true) !== 0x06054b50) at -= 1;
    const directory = view.getUint32(at + 16, true);
    view.setUint32(directory + 24, 200 * 1024 * 1024, true);
    expect(() => inspectWordFile(forged)).toThrow(/expands past/);
  });

  it("adds a table of contents Word fills in on open, listing headings by level", () => {
    const edited = editWordFile(createWordFile(), [
      {
        kind: "insertParagraphs",
        at: "start",
        paragraphs: [
          { text: "Plan", style: "heading1" },
          { text: "Scope", style: "heading2" },
          { text: "Detail", style: "heading4" },
          { text: "Looks like a heading, **isn't one**" },
        ],
      },
      { kind: "insertTableOfContents", at: "start", levels: 2 },
    ]);
    expect(edited.results).toContainEqual({ operation: 1, blocks: "0" });
    const files = unzipSync(edited.bytes);
    expect(strFromU8(files["word/document.xml"]!)).toMatch(/TOC \\o "1-2"/);
    // New files have no settings part; one is added, typed and related, with the flag.
    expect(strFromU8(files["word/settings.xml"]!)).toContain('<w:updateFields w:val="true"/>');
    expect(strFromU8(files["[Content_Types].xml"]!)).toContain('PartName="/word/settings.xml"');
    expect(strFromU8(files["word/_rels/document.xml.rels"]!)).toContain('Target="settings.xml"');
    expect(inspectWordFile(edited.bytes).blocks[0]).toEqual({
      block: 0,
      type: "tableOfContents",
      levels: 2,
    });
    expect(previewWordFile(edited.bytes).blocks[0]).toEqual({
      type: "tableOfContents",
      entries: [
        { level: 1, text: "Plan" },
        { level: 2, text: "Scope" },
      ],
    });
    // Saving again keeps a single flag.
    const again = editWordFile(edited.bytes, [{ kind: "setTitle", title: "Plan" }]);
    expect(
      strFromU8(unzipSync(again.bytes)["word/settings.xml"]!).match(/updateFields/g),
    ).toHaveLength(1);
  });

  it("replaces the header and footer rather than stacking them, references first", () => {
    const first = editWordFile(createWordFile(), [
      { kind: "setHeader", text: "Draft" },
      { kind: "setFooter", text: "Page", pageNumber: true },
    ]);
    const second = editWordFile(first.bytes, [{ kind: "setHeader", text: "Final" }]);
    const inspected = inspectWordFile(second.bytes);
    expect(inspected.headers).toEqual(["Final"]);
    expect(inspected.footers).toEqual(["Page 1"]);
    const files = unzipSync(second.bytes);
    const section = /<w:sectPr>([\s\S]*?)<\/w:sectPr>/.exec(
      strFromU8(files["word/document.xml"]!),
    )![1]!;
    expect(section.match(/headerReference/g)).toHaveLength(1);
    expect(section.indexOf("footerReference")).toBeLessThan(section.indexOf("pgSz"));
    // The replaced header's part and relationship go with it.
    expect(Object.keys(files).filter((name) => name.startsWith("word/header"))).toHaveLength(1);
    expect(validate(openDocx(second.bytes)).filter((issue) => issue.level === "error")).toEqual([]);
    const cleared = editWordFile(second.bytes, [
      { kind: "setHeader", text: "" },
      { kind: "setFooter", text: "" },
    ]);
    expect(inspectWordFile(cleared.bytes)).toMatchObject({ headers: [], footers: [] });
  });

  it("writes links and footnotes, and refuses a link that isn't web or mail", () => {
    const edited = editWordFile(createWordFile(), [
      {
        kind: "insertParagraphs",
        at: "start",
        paragraphs: [
          { text: "See [the site](https://example.com/a?b=1) or [mail](mailto:a@b.c)." },
        ],
      },
      { kind: "addFootnote", block: 0, text: "Checked in May." },
    ]);
    const files = unzipSync(edited.bytes);
    const rels = strFromU8(files["word/_rels/document.xml.rels"]!);
    expect(rels).toContain('Target="https://example.com/a?b=1"');
    expect(rels).toContain('TargetMode="External"');
    expect(strFromU8(files["word/footnotes.xml"]!)).toContain("Checked in May.");
    const inspected = inspectWordFile(edited.bytes);
    expect(inspected.footnotes).toBe(1);
    expect(inspected.blocks[0]).toMatchObject({ text: "See the site or mail." });
    expect(() =>
      editWordFile(createWordFile(), [
        {
          kind: "insertParagraphs",
          at: "start",
          paragraphs: [{ text: "[x](file:///etc/passwd)" }],
        },
      ]),
    ).toThrow(/http, https or mailto/);
  });

  it("inserts a picture at its own size or a given width, with a caption, and previews it", () => {
    // 2×1 PNG.
    const png = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgQEADgMCAXl3Jk0AAAAASUVORK5CYII=",
      ),
      (character) => character.charCodeAt(0),
    );
    const edited = editWordFile(createWordFile(), [
      {
        kind: "insertImage",
        at: "start",
        imageRef: png,
        width: 8,
        altText: "A chart",
        caption: "Figure 1",
      },
    ]);
    expect(edited.results).toEqual([{ operation: 0, blocks: "0-1" }]);
    const xml = strFromU8(unzipSync(edited.bytes)["word/document.xml"]!);
    // 8 cm wide, half as tall, as the picture is.
    expect(xml).toContain('cx="2880000" cy="1440000"');
    expect(inspectWordFile(edited.bytes).blocks[0]).toMatchObject({ pictures: 1 });
    const [picture, caption] = previewWordFile(edited.bytes).blocks;
    expect(picture).toMatchObject({
      pictures: [
        {
          width: 302,
          height: 151,
          alt: "A chart",
          src: expect.stringMatching(/^data:image\/png;base64,/),
        },
      ],
    });
    expect(caption).toMatchObject({ runs: [{ text: "Figure 1" }] });
    expect(() =>
      editWordFile(createWordFile(), [
        { kind: "insertImage", at: "end", imageRef: new TextEncoder().encode("<svg/>") },
      ]),
    ).toThrow(/not a PNG or JPEG/);
  });

  it("restyles a style everywhere it's used, in the order Word reads its properties", () => {
    const made = editWordFile(createWordFile(), [
      { kind: "insertParagraphs", at: "start", paragraphs: [{ text: "Plan", style: "heading1" }] },
    ]);
    const restyled = editWordFile(made.bytes, [
      {
        kind: "setStyle",
        style: "Heading 1",
        font: "Georgia",
        size: 18,
        color: "#1F3864",
        bold: false,
      },
      { kind: "setStyle", style: "normal", spaceAfter: 6, lineSpacing: 1.15 },
    ]);
    const styles = strFromU8(unzipSync(restyled.bytes)["word/styles.xml"]!);
    const heading = /<w:style[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/.exec(styles)![0];
    expect(heading).toContain('<w:rFonts w:ascii="Georgia"');
    expect(heading).toContain('<w:color w:val="1F3864"/>');
    expect(heading).toContain('<w:sz w:val="36"/>');
    expect(heading).toContain('<w:b w:val="0"/>');
    // rFonts, b, color, sz: the schema's order, whatever order they were set in.
    const order = ["rFonts", "<w:b ", "color", "<w:sz "].map((name) => heading.indexOf(name));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
    const normal = /<w:style[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/.exec(styles)![0];
    expect(normal).toContain('w:after="120"');
    expect(normal).toContain('w:line="276"');
    expect(validate(openDocx(restyled.bytes)).filter((issue) => issue.level === "error")).toEqual(
      [],
    );
  });

  it("applies any paragraph style the document defines, by name or id", () => {
    const template = createDocx({ paragraphs: [] });
    addStyle(template, {
      type: "paragraph",
      styleId: "MemoText",
      name: "Memo Text",
      basedOn: "Normal",
    });
    const bytes = toUint8Array(template);
    expect(inspectWordFile(bytes).styles).toContain("Memo Text");
    const edited = editWordFile(bytes, [
      { kind: "insertParagraphs", at: "start", paragraphs: [{ text: "Note", style: "memo text" }] },
    ]);
    expect(inspectWordFile(edited.bytes).blocks[0]).toMatchObject({
      style: "MemoText",
      text: "Note",
    });
    expect(() =>
      editWordFile(bytes, [
        { kind: "insertParagraphs", at: "start", paragraphs: [{ text: "x", style: "Fancy" }] },
      ]),
    ).toThrow(/no paragraph style "Fancy"; this document has .*Memo Text/);
  });

  it("adds page numbers beside what a footer holds, and changes or removes them later", () => {
    const branded = editWordFile(createWordFile(), [
      { kind: "setHeader", text: "ACME Corp" },
      { kind: "setFooter", text: "Confidential" },
    ]);
    const numbered = editWordFile(branded.bytes, [
      {
        kind: "setPageNumbers",
        text: "Page {page} of {pages}",
        align: "right",
        font: "Arial",
        size: 9,
        color: "#808080",
        bold: true,
      },
      { kind: "setHeader", text: "Draft 2", mode: "append" },
    ]);
    const footerOf = (bytes: Uint8Array) =>
      strFromU8(
        Object.entries(unzipSync(bytes)).find(([name]) => name.startsWith("word/footer"))![1],
      );
    let inspected = inspectWordFile(numbered.bytes);
    // The library's summary runs a part's paragraphs together.
    expect(inspected.headers).toEqual(["ACME CorpDraft 2"]);
    expect(inspected.footers).toEqual(["ConfidentialPage 1 of 1"]);
    expect(inspected.pageNumbers).toEqual(["footer"]);
    const footer = footerOf(numbered.bytes);
    expect(footer).toMatch(/instrText[^>]*> PAGE </);
    expect(footer).toMatch(/instrText[^>]*> NUMPAGES </);
    expect(footer).toContain('<w:jc w:val="right"/>');
    // The numbers' look, in the order Word reads run properties.
    expect(footer).toContain(
      '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial" w:eastAsia="Arial"/><w:b/><w:bCs/><w:color w:val="808080"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>',
    );

    // Again: the old numbers go, the footer's own line stays.
    const moved = editWordFile(numbered.bytes, [
      { kind: "setPageNumbers", where: "header", text: "- {page} -", align: "left" },
    ]);
    inspected = inspectWordFile(moved.bytes);
    expect(inspected.pageNumbers).toEqual(["header"]);
    expect(inspected.footers).toEqual(["Confidential"]);
    expect(inspected.headers).toEqual(["ACME CorpDraft 2- 1 -"]);
    const removed = editWordFile(moved.bytes, [{ kind: "setPageNumbers", where: "none" }]);
    expect(inspectWordFile(removed.bytes)).toMatchObject({
      pageNumbers: [],
      headers: ["ACME CorpDraft 2"],
    });
    expect(validate(openDocx(removed.bytes)).filter((issue) => issue.level === "error")).toEqual(
      [],
    );
    expect(() => parseWordOperations([{ kind: "setPageNumbers", text: "Page {pages}" }])).toThrow(
      /include \{page\}/,
    );
  });

  it("replaces page numbers Word itself put in, even alone in a footer", () => {
    const made = editWordFile(createWordFile(), [{ kind: "setFooter", text: "x" }]);
    const files = unzipSync(made.bytes);
    const name = Object.keys(files).find((each) => each.startsWith("word/footer"))!;
    // Word's own form: a simple field, the footer's only paragraph.
    files[name] = strToU8(
      strFromU8(files[name]!).replace(
        /<w:p>[\s\S]*<\/w:p>/,
        '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:fldSimple w:instr=" PAGE   \\* MERGEFORMAT "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>',
      ),
    );
    const word = zipSync(files);
    expect(inspectWordFile(word).pageNumbers).toEqual(["footer"]);
    const removed = editWordFile(word, [{ kind: "setPageNumbers", where: "none" }]);
    const footer = strFromU8(unzipSync(removed.bytes)[name]!);
    expect(footer).not.toContain("PAGE");
    // A footer keeps one paragraph, as the schema asks.
    expect(footer).toContain("<w:p/>");
  });

  it("skips the first page, starts and styles the numbering in section order", () => {
    const edited = editWordFile(createWordFile(), [
      {
        kind: "setPageNumbers",
        skipFirstPage: true,
        startAt: 0,
        numberStyle: "lowerRoman",
      },
      { kind: "setPageLayout", size: "A4", margins: "narrow" },
    ]);
    expect(inspectWordFile(edited.bytes)).toMatchObject({
      pageNumbers: ["footer"],
      firstPageDifferent: true,
    });
    const section = /<w:sectPr>([\s\S]*?)<\/w:sectPr>/.exec(
      strFromU8(unzipSync(edited.bytes)["word/document.xml"]!),
    )![1]!;
    expect(section).toContain('w:top="720"');
    expect(section).toMatch(/<w:pgNumType w:start="0" w:fmt="lowerRoman"\/>/);
    const positions = ["footerReference", "pgSz", "pgMar", "pgNumType", "titlePg"].map((name) =>
      section.indexOf(`<w:${name}`),
    );
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    const undone = editWordFile(edited.bytes, [{ kind: "setPageNumbers", skipFirstPage: false }]);
    expect(strFromU8(unzipSync(undone.bytes)["word/document.xml"]!)).not.toContain("titlePg");
  });

  it("counts past the inspected document through what the call added, as a new one is written", () => {
    // What a model sent for a new document: numbers as the call itself builds it.
    const written = editWordFile(createWordFile(), [
      {
        kind: "insertParagraphs",
        at: "end",
        paragraphs: [
          { text: "Report", style: "title" },
          { text: "Numbers", style: "heading1" },
        ],
      },
      {
        kind: "insertTable",
        after: 2,
        rows: [
          ["Region", "Revenue"],
          ["North", "120"],
        ],
      },
      { kind: "insertParagraphs", after: 3, paragraphs: [{ text: "Closing" }] },
    ]);
    expect(
      inspectWordFile(written.bytes).blocks.map((item) =>
        item.type === "table" ? "table" : item.text,
      ),
    ).toEqual(["", "Report", "Numbers", "table", "Closing"]);
    expect(() =>
      editWordFile(createWordFile(), [{ kind: "insertTable", after: 11, rows: [["a"]] }]),
    ).toThrow(
      /had 1 when inspected and has 1 at this point of the call. To add after everything, use at: "end"/,
    );
  });

  it("gives bullets a character Word can draw, and declares the current Word version", () => {
    const edited = editWordFile(createWordFile(), [
      {
        kind: "insertParagraphs",
        at: "end",
        paragraphs: [
          { text: "a", list: "bullet" },
          { text: "b", list: "bullet", level: 1 },
        ],
      },
    ]);
    const files = unzipSync(edited.bytes);
    const numbering = strFromU8(files["word/numbering.xml"]!);
    // The library leaves these empty, which Word draws as nothing.
    expect(numbering).not.toContain('<w:lvlText w:val=""/>');
    expect(numbering).toContain('<w:lvlText w:val="\u2022"/>');
    expect(numbering).toMatch(/<w:lvlText w:val="o"\/>[\s\S]*?w:ascii="Courier New"/);
    expect(strFromU8(files["word/settings.xml"]!)).toContain(
      '<w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>',
    );
  });

  it("refuses a lone surrogate half, which XML can't carry, but keeps a whole pair", () => {
    expect(() =>
      parseWordOperations([
        { kind: "insertParagraphs", at: "end", paragraphs: [{ text: "a\ud800b" }] },
      ]),
    ).toThrow(/control characters/);
    expect(
      parseWordOperations([
        { kind: "insertParagraphs", at: "end", paragraphs: [{ text: "cake \u{1F370}" }] },
      ]),
    ).toHaveLength(1);
  });
});
