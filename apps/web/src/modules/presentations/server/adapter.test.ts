import { describe, expect, it } from "vitest";
import {
  addBlankSlide,
  addSlideImage,
  getParagraphLevel,
  getPresentationTheme,
  getShapeChartSpec,
  getTableColumnWidths,
  groupShapes,
  getShapeId,
  getShapeRunCount,
  getShapeRunFormat,
  getShapeText,
  addSlideTextBox,
  createPresentation,
  getShapeImageBytes,
  getShapeImagePartName,
  getSlideShapes,
  getSlides,
  loadPresentation,
  pt,
  savePresentation,
} from "@office-kit/pptx";
import { strToU8, unzipSync, zipSync } from "fflate";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  checkFontFile,
  createPresentationDraft,
  editPresentation,
  inspectPresentation,
  renderPresentation,
} from "./adapter.ts";
import { readPresentationArchive } from "./archive.ts";
import { parsePresentationOperations } from "../operations.ts";
import { isSummary, type InspectScope } from "./inspection.ts";

const picture = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uAAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const replacePart = (bytes: Uint8Array, name: string, transform: (text: string) => string) => {
  const parts = readPresentationArchive(bytes);
  parts.set(name, strToU8(transform(new TextDecoder().decode(parts.get(name)!))));
  return zipSync(Object.fromEntries(parts));
};

/** Everything an inspection can report, with every slide's shapes. */
async function inspect(bytes: Uint8Array, scope: InspectScope = {}) {
  const inspection = await inspectPresentation(bytes, {
    slides: "all",
    shapes: true,
    owners: true,
    catalog: true,
    ...scope,
  });
  return {
    ...inspection,
    layouts: inspection.layouts ?? [],
    masters: inspection.masters ?? [],
    slides: inspection.slides
      .filter(isSummary)
      .map((slide) => ({ ...slide, shapes: slide.shapes ?? [] })),
  };
}

async function textDeck() {
  const deck = createPresentation();
  const slide = addBlankSlide(deck);
  addSlideTextBox(slide, { x: pt(40), y: pt(50), w: pt(300), h: pt(70), text: "Original" });
  return savePresentation(deck);
}

// An edit that touches the slide's text but not the crowded box, so the audit runs.
const nudge = (target: { slideId: number }) => ({
  kind: "addText",
  ...target,
  x: 600,
  y: 420,
  width: 200,
  height: 40,
  text: "ok",
});

const crowded = (ref: string) => ({
  kind: "addText",
  slideRef: ref,
  x: 40,
  y: 40,
  width: 200,
  height: 20,
  text: "One\nTwo\nThree\nFour\nFive",
});

// Header-only images: enough for format and size checks, which is all a deck's own media gets.
const hex = (text: string) => [...Buffer.from(text, "hex")];
const jpeg = (width: number, height: number) =>
  new Uint8Array([
    ...hex("ffd8ffc0001108"),
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    ...hex("03012200021101031101ffd9"),
    // Bytes after the end-of-image marker, as some cameras and editors write.
    ...hex("00004a554e4b"),
  ]);
const gif = new Uint8Array([
  ...new TextEncoder().encode("GIF89a"),
  ...hex("2800280080000000000000ffffff3b"),
]);
async function pictureDeck(bytes: Uint8Array, format: "jpeg" | "gif") {
  const deck = createPresentation();
  const slide = addBlankSlide(deck);
  addSlideImage(slide, bytes, { x: pt(40), y: pt(40), w: pt(200), h: pt(150), format });
  return savePresentation(deck);
}

const media = (bytes: Uint8Array) =>
  [...readPresentationArchive(bytes)].find(([name]) => name.startsWith("ppt/media/"))!;

describe("presentation core adapter", () => {
  it("creates an editable 16:9 deck with stable slide and layout identities", async () => {
    const bytes = await createPresentationDraft();
    const initial = await inspect(bytes);
    expect(initial.slides).toHaveLength(1);
    expect(initial.layouts.map((layout) => layout.name)).toContain("Blank");
    expect(initial.masters).toHaveLength(1);
    const changed = await editPresentation(bytes, [
      {
        kind: "addText",
        slideId: initial.slides[0]!.slideId,
        text: "Hello <PowerPoint> & all",
        x: 32,
        y: 40,
        width: 380,
        height: 48,
      },
      { kind: "addSlide", layoutId: initial.layouts[0]!.layoutId },
      { kind: "moveSlide", slideId: initial.slides[0]!.slideId, index: 1 },
    ]);
    const after = await inspect(changed.bytes);
    expect(after.slides).toHaveLength(2);
    expect(after.slides[1]?.slideId).toBe(initial.slides[0]?.slideId);
    expect(after.slides[1]?.shapes.map((shape) => shape.text)).toContain(
      "Hello <PowerPoint> & all",
    );
    const out = unzipSync(changed.bytes);
    expect(Object.keys(out)).toContain("ppt/presentation.xml");
    expect(new TextDecoder().decode(out["ppt/slides/slide1.xml"])).toContain(
      "&lt;PowerPoint&gt; &amp; all",
    );
    expect(changed.bytes.length).toBeLessThan(20 * 1024 * 1024);
  });

  it("starts new decks from a 16:9 template with the standard layouts", async () => {
    const inspection = await inspect(await createPresentationDraft());
    expect(inspection.layouts.map((layout) => layout.name)).toEqual(
      expect.arrayContaining([
        "Blank",
        "Title Slide",
        "Title and Content",
        "Title Only",
        "Section Header",
        "Two Content",
      ]),
    );
    const [first] = inspection.slides;
    expect(first).toMatchObject({ layoutName: "Title Slide", placeholders: ["title", "subtitle"] });
    const deck = await createPresentationDraft();
    const two = await editPresentation(deck, [{ kind: "addSlide", layoutId: "Two Content" }]);
    const bodies = (await inspect(two.bytes)).slides[1]!.shapes.filter((shape) =>
      shape.placeholder?.startsWith("body"),
    );
    // Both columns sit inside the 960-point-wide slide, side by side.
    expect(bodies.map((shape) => shape.placeholder)).toEqual(["body", "body2"]);
    expect(bodies[1]!.bounds!.x).toBeGreaterThan(
      bodies[0]!.bounds!.x + bodies[0]!.bounds!.width - 1,
    );
    expect(bodies[1]!.bounds!.x + bodies[1]!.bounds!.width).toBeLessThanOrEqual(960);
    const catalog = inspection.layouts.find((layout) => layout.name === "Two Content")!;
    for (const shape of bodies)
      expect(
        catalog.textTargets.find((target) => target.placeholder === shape.placeholder)?.bounds,
      ).toEqual(shape.bounds);
  });

  it("fills placeholders and adds bullets, tables, charts and notes with batch refs", async () => {
    const draft = await createPresentationDraft();
    const before = readPresentationArchive(draft);
    const titleSlide = (await inspect(draft)).slides[0]!.slideId;
    const edited = await editPresentation(draft, [
      { kind: "setText", slideId: titleSlide, placeholder: "title", text: "Q3" },
      { kind: "addSlide", layoutId: "Title and Content", ref: "points" },
      {
        kind: "setText",
        slideRef: "points",
        placeholder: "body",
        paragraphs: [
          { text: "Revenue up" },
          { text: "Online doubled", level: 1 },
          { runs: [{ text: "New: ", bold: true }, { text: "sourdough" }] },
        ],
      },
      { kind: "setNotes", slideRef: "points", text: "Mention the bakery" },
      {
        kind: "addTable",
        slideRef: "points",
        x: 500,
        y: 300,
        width: 300,
        height: 100,
        rows: [
          ["Item", "Units"],
          ["Bread", "10"],
        ],
        ref: "units",
      },
      {
        kind: "setTableCells",
        slideRef: "points",
        shapeRef: "units",
        cells: [{ row: 1, column: 1, text: "12" }],
      },
      { kind: "addTableRow", slideRef: "points", shapeRef: "units", cells: ["Pies", "3"] },
      {
        kind: "addChart",
        slideRef: "points",
        x: 60,
        y: 300,
        width: 300,
        height: 200,
        chartType: "column",
        title: "Sales",
        legend: "bottom",
        categories: ["Jul", "Aug"],
        series: [{ name: "Sales", values: [1, 2] }],
        ref: "sales",
      },
      {
        kind: "updateChart",
        slideRef: "points",
        shapeRef: "sales",
        categories: ["Jul", "Aug", "Sep"],
        series: [{ name: "Sales", values: [1, 2, 3] }],
      },
      {
        kind: "addShape",
        slideRef: "points",
        shape: "roundRect",
        x: 10,
        y: 10,
        width: 80,
        height: 30,
        fill: "#2563EB",
        text: "Tag",
        ref: "tag",
      },
      { kind: "setBounds", slideRef: "points", shapeRef: "tag", x: 20 },
      { kind: "styleShape", slideRef: "points", shapeRef: "tag", line: "none" },
    ]);
    expect(Object.keys(edited.refs.slides)).toEqual(["points"]);
    expect(Object.keys(edited.refs.shapes)).toEqual(["units", "sales", "tag"]);
    const inspected = await inspect(edited.bytes);
    const slide = inspected.slides[1]!;
    expect(slide.notes).toBe("Mention the bakery");
    expect(inspected.slides[0]!.shapes.find((shape) => shape.placeholder === "title")?.text).toBe(
      "Q3",
    );
    expect(slide.shapes.find((shape) => shape.placeholder === "body")?.text).toBe(
      "Revenue up\nOnline doubled\nNew: sourdough",
    );
    expect(slide.shapes.find((shape) => shape.kind === "table")).toMatchObject({
      table: {
        rows: 3,
        columns: 2,
        cells: [
          ["Item", "Units"],
          ["Bread", "12"],
          ["Pies", "3"],
        ],
      },
    });
    expect(slide.shapes.find((shape) => shape.kind === "chart")).toMatchObject({
      chart: {
        type: "column",
        title: "Sales",
        categories: ["Jul", "Aug", "Sep"],
        series: ["Sales"],
      },
    });
    expect(
      slide.shapes.find((shape) => shape.shapeId === edited.refs.shapes.tag!.shapeId)?.bounds?.x,
    ).toBe(20);
    const after = readPresentationArchive(edited.bytes);
    // Notes need a notes master, which Office Kit does not write itself.
    expect(new TextDecoder().decode(after.get("ppt/presentation.xml"))).toContain(
      "notesMasterIdLst",
    );
    const notesRels = [...after.keys()].find((name) => /notesSlides\/_rels\//.test(name))!;
    expect(new TextDecoder().decode(after.get(notesRels))).toContain("notesMaster");
    for (const name of [
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout3.xml",
      "ppt/theme/theme1.xml",
    ])
      expect(after.get(name)).toEqual(before.get(name));
    const reread = await loadPresentation(edited.bytes);
    const body = getSlideShapes(getSlides(reread)[1]!).find((shape) =>
      getShapeText(shape).startsWith("Revenue"),
    )!;
    expect(getParagraphLevel(body, 1)).toBe(1);
    expect(getShapeRunFormat(body, 2, 0)?.bold).toBe(true);
  });

  it("names the failing operation and explains missing placeholders", async () => {
    const draft = await createPresentationDraft();
    const id = (await inspect(draft)).slides[0]!.slideId;
    await expect(
      editPresentation(draft, [
        { kind: "setText", slideId: id, placeholder: "title", text: "ok" },
        { kind: "setText", slideId: id, placeholder: "body", text: "nope" },
      ]),
    ).rejects.toThrow(
      /^operations\[1\] setText: This slide has no body placeholder \(it has: title, subtitle\)/,
    );
    await expect(
      editPresentation(draft, [
        { kind: "setText", slideId: 9999, placeholder: "title", text: "x" },
      ]),
    ).rejects.toThrow(/Slide 9999 does not exist/);
  });

  it("edits text inside groups, moves groups whole and ungroups them", async () => {
    const deck = createPresentation();
    const slide = addBlankSlide(deck);
    const first = addSlideTextBox(slide, {
      x: pt(10),
      y: pt(10),
      w: pt(100),
      h: pt(30),
      text: "A",
    });
    const second = addSlideTextBox(slide, {
      x: pt(10),
      y: pt(50),
      w: pt(100),
      h: pt(30),
      text: "B",
    });
    groupShapes([first, second]);
    const bytes = await savePresentation(deck);
    const inspected = (await inspect(bytes)).slides[0]!;
    const group = inspected.shapes.find((shape) => shape.kind === "group")!;
    const child = inspected.shapes.find((shape) => shape.text === "A")!;
    expect(child).toMatchObject({ groupId: group.shapeId, editable: true });
    const slideId = inspected.slideId;
    const edited = await editPresentation(bytes, [
      { kind: "setText", slideId, shapeId: child.shapeId, text: "Changed" },
      { kind: "setBounds", slideId, shapeId: group.shapeId, x: 300 },
    ]);
    expect((await inspect(edited.bytes)).slides[0]!.shapes.map((shape) => shape.text)).toContain(
      "Changed",
    );
    await expect(
      editPresentation(bytes, [{ kind: "setBounds", slideId, shapeId: child.shapeId, x: 5 }]),
    ).rejects.toThrow(/inside a group; move, reorder or remove the group/);
    const ungrouped = await editPresentation(edited.bytes, [
      { kind: "ungroup", slideId, shapeId: group.shapeId },
    ]);
    expect(
      (await inspect(ungrouped.bytes)).slides[0]!.shapes.some((shape) => shape.kind === "group"),
    ).toBe(false);
  });

  it("names every layout sharing a name instead of claiming none matches", async () => {
    const parts = readPresentationArchive(await createPresentationDraft());
    const titleOnly = [...parts].find(
      ([name, bytes]) =>
        /slideLayouts\/slideLayout\d+\.xml$/.test(name) &&
        new TextDecoder().decode(bytes).includes('name="Title Only"'),
    )!;
    parts.set(
      titleOnly[0],
      strToU8(new TextDecoder().decode(titleOnly[1]).replace('name="Title Only"', 'name="Blank"')),
    );
    const deck = zipSync(Object.fromEntries(parts));
    const error = await editPresentation(deck, [{ kind: "addSlide", layoutId: "Blank" }]).catch(
      (cause: Error) => cause,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/"Blank" matches 2 layouts; pass one layoutId: /);
    expect((error as Error).message).toContain(`/${titleOnly[0]}`);
    const added = await editPresentation(deck, [
      { kind: "addSlide", layoutId: `/${titleOnly[0]}` },
    ]);
    expect(added.inspection.slides.at(-1)!.layoutId).toBe(`/${titleOnly[0]}`);
  });

  it("removes a slide together with its speaker notes", async () => {
    const draft = await createPresentationDraft();
    const edited = await editPresentation(draft, [
      { kind: "addSlide", layoutId: "Title Only", ref: "noted" },
      { kind: "setNotes", slideRef: "noted", text: "Say hello" },
    ]);
    const noted = edited.refs.slides["noted"]!;
    const removed = await editPresentation(edited.bytes, [{ kind: "removeSlide", slideId: noted }]);
    const parts = readPresentationArchive(removed.bytes);
    expect([...parts.keys()].filter((name) => name.includes("notesSlides/"))).toEqual([]);
    const types = new TextDecoder().decode(parts.get("[Content_Types].xml"));
    expect(types).not.toContain("notesSlides/");
    expect(removed.inspection.slides.map((slide) => slide.slideId)).not.toContain(noted);
  });

  it("duplicates slides with charts and notes into independent copies", async () => {
    const draft = await createPresentationDraft();
    const edited = await editPresentation(draft, [
      { kind: "addSlide", layoutId: "Title Only", ref: "data" },
      { kind: "setNotes", slideRef: "data", text: "Explain the numbers" },
      {
        kind: "addChart",
        slideRef: "data",
        x: 40,
        y: 150,
        width: 300,
        height: 200,
        chartType: "column",
        categories: ["Q1", "Q2"],
        series: [{ name: "Sales", values: [1, 2] }],
        ref: "chart",
      },
      { kind: "duplicateSlide", slideRef: "data", ref: "copy" },
    ]);
    const [, original, copy] = (await inspect(edited.bytes)).slides;
    expect(copy!.notes).toBe("Explain the numbers");
    const copyChart = copy!.shapes.find((shape) => shape.kind === "chart")!;
    const updated = await editPresentation(edited.bytes, [
      {
        kind: "updateChart",
        slideId: copy!.slideId,
        shapeId: copyChart.shapeId,
        categories: ["Q1", "Q2"],
        series: [{ name: "Sales", values: [5, 6] }],
      },
    ]);
    const parts = readPresentationArchive(updated.bytes);
    // Each copy owns its chart part and notes, and both link to a notes master.
    expect(
      [...parts.keys()].filter((name) => /^ppt\/charts\/chart[^/]*\.xml$/.test(name)),
    ).toHaveLength(2);
    for (const name of [...parts.keys()].filter((key) => /notesSlides\/_rels\//.test(key)))
      expect(new TextDecoder().decode(parts.get(name))).toContain("notesMaster");
    expect(readPresentationArchive(edited.bytes).get("ppt/charts/chart1.xml")).toEqual(
      parts.get("ppt/charts/chart1.xml"),
    );
    expect(original!.shapes.some((shape) => shape.kind === "chart")).toBe(true);
  });

  it("shares canonical names across layouts and slides, including body5 and raw types", async () => {
    const source = await createPresentationDraft();
    const extend = (xml: string) => {
      const subtitle = xml
        .match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)!
        .find((shape) => shape.includes('type="subTitle"'))!;
      const bodies = Array.from({ length: 6 }, (_, index) =>
        subtitle
          .replace(/<p:cNvPr\b[^>]*\bid="\d+"/, `<p:cNvPr id="${100 + index}"`)
          .replace(/<p:ph\b[^>]*\/?\s*>/, `<p:ph type="obj" idx="${10 + index}"/>`),
      ).join("");
      return xml.replace("</p:spTree>", `${bodies}</p:spTree>`);
    };
    const sourceLayout = (await inspect(source)).slides[0]!.layoutId!;
    const withLayout = replacePart(source, sourceLayout.slice(1), extend);
    const bytes = replacePart(withLayout, "ppt/slides/slide1.xml", extend);
    const inspection = await inspect(bytes, { templateId: sourceLayout });
    const names = ["title", "subtitle", "body", "body2", "body3", "body4", "body5", "body6"];
    expect(inspection.slides[0]!.placeholders).toEqual(names);
    expect(
      inspection
        .template!.shapes.filter((shape) => shape.placeholder)
        .map((shape) => shape.placeholder),
    ).toEqual(names);
    const catalog = inspection.layouts.find((layout) => layout.layoutId === sourceLayout)!;
    expect(catalog.textTargets.map((target) => target.placeholder)).toEqual(names);
    expect(catalog.textTargets.every((target) => !("shapeId" in target))).toBe(true);
    expect(
      inspection.slides[0]!.shapes.find((shape) => shape.placeholder === "body5")?.placeholderType,
    ).toBe("obj");
    const edited = await editPresentation(bytes, [
      { kind: "removeShape", slideRef: "first", placeholder: "body" },
      { kind: "setText", slideRef: "first", placeholder: "body5", text: "Fifth" },
    ]);
    expect(
      (await inspect(edited.bytes)).slides[0]!.shapes.find((shape) => shape.placeholder === "body5")
        ?.text,
    ).toBe("Fifth");
  });

  it("rejects ambiguous semantic placeholders and reports current move bounds atomically", async () => {
    const source = await createPresentationDraft();
    const bytes = replacePart(source, "ppt/slides/slide1.xml", (xml) => {
      const title = xml
        .match(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g)!
        .find((shape) => shape.includes('type="ctrTitle"'))!;
      return xml.replace(
        "</p:spTree>",
        `${title.replace(/<p:cNvPr\b[^>]*\bid="\d+"/, '<p:cNvPr id="99"')}</p:spTree>`,
      );
    });
    await expect(
      editPresentation(bytes, [
        { kind: "setText", slideRef: "first", placeholder: "title", text: "No guessing" },
      ]),
    ).rejects.toThrow(/operations\[0\] setText: Placeholder "title" is ambiguous.*shapeId/);
    const exact = await editPresentation(bytes, [
      { kind: "setText", slideRef: "first", shapeId: 99, text: "Exact" },
    ]);
    expect(
      (await inspect(exact.bytes)).slides[0]!.shapes.find((shape) => shape.shapeId === 99)?.text,
    ).toBe("Exact");
    await expect(
      editPresentation(source, [
        { kind: "addSlide", layoutId: "Blank" },
        { kind: "moveSlide", slideRef: "first", index: 2 },
      ]),
    ).rejects.toThrow(
      /operations\[1\] moveSlide: index 2.*0\.\.1.*2 slides after preceding operations/,
    );
  });

  it("rebinds layouts without inventing placeholders; new slides instantiate them", async () => {
    const source = await createPresentationDraft();
    const before = (await inspect(source)).slides[0]!;
    const edited = await editPresentation(source, [
      { kind: "setSlideLayout", slideRef: "first", layoutId: "Two Content" },
      { kind: "addSlide", layoutId: "Two Content" },
    ]);
    const after = await inspect(edited.bytes);
    expect(after.slides[0]!.shapes.map((shape) => shape.shapeId)).toEqual(
      before.shapes.map((shape) => shape.shapeId),
    );
    expect(after.slides[0]!.placeholders).toEqual(["title", "subtitle"]);
    expect(after.slides[1]!.placeholders).toEqual(["title", "body", "body2"]);
  });

  it("keeps placeholder names stable when a slide loses one", async () => {
    const edited = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Two Content", ref: "two" },
      { kind: "removeShape", slideRef: "two", placeholder: "body" },
      { kind: "setText", slideRef: "two", placeholder: "body2", text: "Right" },
    ]);
    expect((await inspect(edited.bytes)).slides[1]!.placeholders).toEqual(["title", "body2"]);
  });

  it("edits layouts and masters: background, footer wording, a shape and a logo", async () => {
    const source = await textDeck();
    const withPicture = await editPresentation(source, [
      {
        kind: "addImage",
        slideId: (await inspect(source)).slides[0]!.slideId,
        imageRef: picture,
        x: 10,
        y: 10,
        width: 40,
        height: 40,
      },
    ]);
    // Move a copy of the slide's picture onto the layout, as a template logo.
    const slideParts = readPresentationArchive(withPicture.bytes);
    const slideXml = new TextDecoder().decode(slideParts.get("ppt/slides/slide1.xml"));
    const pictureXml = slideXml
      .match(/<p:pic>[\s\S]*?<\/p:pic>/)![0]
      .replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="90"');
    const embed = pictureXml.match(/r:embed="([^"]+)"/)![1]!;
    const media = new TextDecoder()
      .decode(slideParts.get("ppt/slides/_rels/slide1.xml.rels"))
      .match(new RegExp(`Id="${embed}"[^>]*Target="([^"]+)"`))![1]!;
    let templated = replacePart(withPicture.bytes, "ppt/slideLayouts/slideLayout1.xml", (xml) =>
      xml.replace("</p:spTree>", `${pictureXml.replace(embed, "rId90")}</p:spTree>`),
    );
    templated = replacePart(templated, "ppt/slideLayouts/_rels/slideLayout1.xml.rels", (xml) =>
      xml.replace(
        "</Relationships>",
        `<Relationship Id="rId90" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${media}"/></Relationships>`,
      ),
    );
    const inspected = await inspect(templated, {
      templateId: "/ppt/slideLayouts/slideLayout1.xml",
    });
    expect(inspected.template?.shapes).toEqual(
      expect.arrayContaining([expect.objectContaining({ shapeId: 90, kind: "picture" })]),
    );
    const master = inspected.masters[0]!;
    const replacement = (await renderPresentation(source, [inspected.slides[0]!.slideId]))[0]!.png;
    const before = readPresentationArchive(templated);
    const edited = await editPresentation(templated, [
      {
        kind: "replaceImage",
        templateId: "/ppt/slideLayouts/slideLayout1.xml",
        shapeId: 90,
        imageRef: replacement,
      },
      { kind: "setBackground", templateId: master, color: "#FAF7F2" },
      {
        kind: "replaceAll",
        find: "Click to edit Master title style",
        replace: "Title",
        scope: "everywhere",
      },
    ]);
    const after = readPresentationArchive(edited.bytes);
    // The slide's own picture and media stay untouched; the layout gets new media.
    expect(after.get("ppt/slides/slide1.xml")).toEqual(before.get("ppt/slides/slide1.xml"));
    expect(after.get(media.replace("../", "ppt/"))).toEqual(
      before.get(media.replace("../", "ppt/")),
    );
    expect(new TextDecoder().decode(after.get("ppt/slideMasters/slideMaster1.xml"))).toContain(
      'val="FAF7F2"',
    );
    expect(new TextDecoder().decode(after.get("ppt/slideMasters/slideMaster1.xml"))).not.toContain(
      "Click to edit Master title style",
    );
    const removed = await editPresentation(edited.bytes, [
      { kind: "removeShape", templateId: "/ppt/slideLayouts/slideLayout1.xml", shapeId: 90 },
    ]);
    expect(
      (
        await inspect(removed.bytes, { templateId: "/ppt/slideLayouts/slideLayout1.xml" })
      ).template?.shapes.some((shape) => shape.shapeId === 90),
    ).toBe(false);
  });

  it("resolves only used owners, keeps hidden candidates and scopes duplicate IDs by owner", async () => {
    const draft = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Title Slide" },
      { kind: "addSlide", layoutId: "Blank" },
    ]);
    const layoutId = draft.inspection.slides[0]!.layoutId!;
    const masterId = draft.inspection.slides[0]!.masterId!;
    expect(masterId).toBe("/ppt/slideMasters/slideMaster1.xml");
    const source = new TextDecoder().decode(
      readPresentationArchive(await textDeck()).get("ppt/slides/slide1.xml"),
    );
    const shapeXml = source
      .match(/<p:sp>[\s\S]*?<\/p:sp>/)![0]
      .replace(/<p:cNvPr id="\d+"/, '<p:cNvPr hidden="1" id="90"');
    let bytes = draft.bytes;
    for (const owner of [layoutId, masterId])
      bytes = replacePart(bytes, owner.slice(1), (xml) =>
        xml.replace("</p:spTree>", `${shapeXml}</p:spTree>`),
      );
    bytes = replacePart(bytes, layoutId.slice(1), (xml) =>
      xml
        .replace("<p:sldLayout ", '<p:sldLayout showMasterSp="0" ')
        .replace(
          "</p:spTree>",
          `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="91" name="Hidden group" hidden="1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapeXml.replace('id="90"', 'id="92"').replace('hidden="1" ', "")}</p:grpSp></p:spTree>`,
        ),
    );
    bytes = replacePart(bytes, "ppt/slides/slide1.xml", (xml) =>
      xml.replace("<p:sld ", '<p:sld showMasterSp="false" '),
    );
    const inspection = await inspect(bytes);
    expect(inspection.slides[0]).toMatchObject({
      masterId,
      showMasterSp: false,
      layoutShowMasterSp: false,
    });
    expect(inspection.templateOwners.map((owner) => owner.templateId)).toEqual([
      ...new Set(inspection.slides.flatMap((slide) => [slide.layoutId, slide.masterId])),
    ]);
    expect(inspection.templateOwners.filter((owner) => owner.templateId === masterId)).toHaveLength(
      1,
    );
    for (const owner of inspection.templateOwners.filter((entry) =>
      [layoutId, masterId].includes(entry.templateId),
    )) {
      expect(owner.targets).toContainEqual(expect.objectContaining({ shapeId: 90, hidden: true }));
      expect(owner.targets.every((shape) => !shape.isPlaceholder)).toBe(true);
    }
    const layout = inspection.templateOwners.find((owner) => owner.templateId === layoutId)!;
    expect(layout.targets).toContainEqual(
      expect.objectContaining({ shapeId: 92, hidden: false, ancestorHidden: true }),
    );
    const target = layout.targets.find((shape) => shape.shapeId === 90)!;
    const edited = await editPresentation(bytes, [
      { kind: "removeShape", templateId: layout.templateId, shapeId: target.shapeId },
    ]);
    expect(
      edited.inspection.templateOwners.find((owner) => owner.templateId === masterId)!.targets,
    ).toContainEqual(expect.objectContaining({ shapeId: 90 }));
    expect(
      edited.inspection.templateOwners
        .find((owner) => owner.templateId === layoutId)!
        .targets.some((shape) => shape.shapeId === 90),
    ).toBe(false);
  });

  it("draws a registered font's family instead of the bundled substitute", async () => {
    const fonts = join(
      dirname(createRequire(import.meta.url).resolve("@office-kit/pptx-preview/package.json")),
      "fonts",
    );
    const draft = await createPresentationDraft();
    const id = (await inspect(draft)).slides[0]!.slideId;
    // "Caladea" is not one of the names the renderer maps, so it normally draws as Calibri.
    const deck = await editPresentation(draft, [
      { kind: "setText", slideId: id, placeholder: "title", text: "Serif", font: "Caladea" },
    ]);
    const plain = (await renderPresentation(deck.bytes, [id]))[0]!.png;
    const path = join(fonts, "Caladea-Regular.ttf");
    const face = await checkFontFile(path);
    const registered = (
      await renderPresentation(deck.bytes, [id], [{ ...face, path, source: "upload" }])
    )[0]!.png;
    expect(Buffer.from(registered).equals(Buffer.from(plain))).toBe(false);
    // A later render in the same process is unaffected by the earlier registration.
    expect(
      Buffer.from((await renderPresentation(deck.bytes, [id]))[0]!.png).equals(Buffer.from(plain)),
    ).toBe(true);
    await expect(checkFontFile(join(fonts, "LICENSES.md"))).rejects.toThrow(/not a TrueType/);
  });

  it("embeds the faces a deck uses, keeps them across edits, drops them when unused, and never touches a deck's own", async () => {
    const path = join(
      import.meta.dirname,
      "../../../../tests/fixtures/fonts/AbrilFatface-Regular.ttf",
    );
    const face = { ...(await checkFontFile(path)), path, source: "google" as const, embed: true };
    const decoder = new TextDecoder();
    const fontParts = (bytes: Uint8Array) =>
      [...readPresentationArchive(bytes).keys()].filter((name) => name.startsWith("ppt/fonts/"));
    const xmlOf = (bytes: Uint8Array, name: string) =>
      decoder.decode(readPresentationArchive(bytes).get(name));

    const draft = await createPresentationDraft();
    const themed = await editPresentation(
      draft,
      [{ kind: "setTheme", headingFont: "Abril Fatface", bodyFont: "Arial" }],
      [face],
    );
    const [part] = fontParts(themed.bytes);
    expect(part).toMatch(/^ppt\/fonts\/chat-[0-9a-f]{8}-regular\.fntdata$/);
    const presentation = xmlOf(themed.bytes, "ppt/presentation.xml");
    expect(presentation).toContain('typeface="Abril Fatface"');
    // Office families are never embedded: the faces held for them are substitutes.
    expect(presentation).not.toContain('typeface="Arial"');
    expect(presentation.match(/embedTrueTypeFonts=/g)).toHaveLength(1);
    expect(presentation).toContain('saveSubsetFonts="0"');
    expect(xmlOf(themed.bytes, "[Content_Types].xml")).toContain('Extension="fntdata"');
    expect(xmlOf(themed.bytes, "ppt/_rels/presentation.xml.rels")).toContain("relationships/font");

    // Another edit keeps exactly the one embedded face, and the deck still previews.
    const id = (await inspect(themed.bytes)).slides[0]!.slideId;
    expect((await renderPresentation(themed.bytes, [id], [face]))[0]!.png.length).toBeGreaterThan(
      0,
    );
    const again = await editPresentation(
      themed.bytes,
      [{ kind: "setText", slideId: id, placeholder: "title", text: "Hello" }],
      [face],
    );
    expect(fontParts(again.bytes)).toEqual([part]);

    // A deck's own embedded font, from PowerPoint or elsewhere, is kept as it was.
    const parts = readPresentationArchive(again.bytes);
    const own = new Uint8Array([1, 2, 3, 4]);
    parts.set("ppt/fonts/font1.fntdata", own);
    parts.set(
      "ppt/_rels/presentation.xml.rels",
      strToU8(
        xmlOf(again.bytes, "ppt/_rels/presentation.xml.rels").replace(
          "</Relationships>",
          '<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/font1.fntdata"/></Relationships>',
        ),
      ),
    );
    parts.set(
      "ppt/presentation.xml",
      strToU8(
        xmlOf(again.bytes, "ppt/presentation.xml").replace(
          "<p:embeddedFontLst>",
          '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Brand Sans"/><p:regular r:id="rId900"/></p:embeddedFont>',
        ),
      ),
    );
    const withOwn = zipSync(Object.fromEntries(parts));

    // The deck stops using Abril Fatface: our face goes, the deck's own stays.
    const plain = await editPresentation(
      withOwn,
      [{ kind: "setTheme", headingFont: "Arial" }],
      [face],
    );
    expect(fontParts(plain.bytes)).toEqual(["ppt/fonts/font1.fntdata"]);
    expect(readPresentationArchive(plain.bytes).get("ppt/fonts/font1.fntdata")).toEqual(own);
    expect(xmlOf(plain.bytes, "ppt/presentation.xml")).toContain('typeface="Brand Sans"');
    expect(xmlOf(plain.bytes, "ppt/presentation.xml")).not.toContain("Abril Fatface");
  });

  it("reports a curated family a deck names but has no face for, and nothing it can draw", async () => {
    const draft = await createPresentationDraft();
    const id = (await inspect(draft)).slides[0]!.slideId;
    const deck = await editPresentation(draft, [
      { kind: "setText", slideId: id, placeholder: "title", text: "Hello", font: "Poppins" },
      { kind: "setTheme", bodyFont: "Arial" },
    ]);
    const [slide] = await renderPresentation(deck.bytes, [id]);
    // Arial is bundled; Poppins is fetched for the next preview.
    expect(slide?.missingFonts).toEqual(["Poppins"]);
  });

  it("classifies box overruns as new, existing or increased without calling them clipping", async () => {
    const draft = await createPresentationDraft();
    const fits = await editPresentation(draft, [
      { kind: "setText", slideRef: "first", placeholder: "title", text: "Short title" },
    ]);
    expect(fits.overflow).toEqual([]);
    const crowded = await editPresentation(draft, [
      {
        kind: "addText",
        slideRef: "first",
        x: 40,
        y: 40,
        width: 200,
        height: 40,
        text: Array.from({ length: 12 }, () => "A line of text").join("\n"),
        ref: "note",
      },
    ]);
    const target = crowded.refs.shapes.note!;
    expect(crowded.overflow).toEqual([
      expect.objectContaining({
        ...target,
        direction: "vertical",
        classification: "new",
        beforeByPoints: null,
      }),
    ]);
    const unchanged = await editPresentation(crowded.bytes, [nudge({ slideId: target.slideId })]);
    expect(unchanged.overflow[0]).toMatchObject({
      classification: "existing",
      beforeByPoints: crowded.overflow[0]!.byPoints,
      byPoints: crowded.overflow[0]!.byPoints,
    });
    // Notes cannot change how text fits, so such an edit is not audited at all.
    const notes = await editPresentation(crowded.bytes, [
      { kind: "setNotes", slideId: target.slideId, text: "Review" },
    ]);
    expect(notes.overflow).toEqual([]);
    expect(notes.overflowSummary.total).toBe(0);
    const minor = await editPresentation(crowded.bytes, [
      { kind: "setBounds", ...target, width: 200, height: 36 },
    ]);
    expect(minor.overflow[0]!.classification).toBe("existing");
    const increased = await editPresentation(crowded.bytes, [
      {
        kind: "setText",
        ...target,
        text: Array.from({ length: 40 }, () => "A line of text").join("\n"),
      },
    ]);
    expect(increased.overflow[0]!.classification).toBe("increased");
    expect(increased.overflow[0]!.byPoints).toBeGreaterThan(
      increased.overflow[0]!.beforeByPoints! + 100,
    );
    expect(increased.overflowSummary).toEqual({
      total: 1,
      omitted: 0,
      counts: { new: 0, increased: 1, existing: 0, uncompared: 0 },
    });
  });

  it("leaves duplicate shape names unmatched and new slides uncompared", async () => {
    const deck = createPresentation();
    const slide = addBlankSlide(deck);
    for (let index = 0; index < 2; index++)
      addSlideTextBox(slide, {
        x: pt(40),
        y: pt(40),
        w: pt(200),
        h: pt(20),
        text: "One\nTwo\nThree\nFour\nFive",
      });
    const bytes = replacePart(await savePresentation(deck), "ppt/slides/slide1.xml", (xml) =>
      xml.replace(/(<p:cNvPr\b[^>]*name=")[^"]*/g, "$1Repeated"),
    );
    const id = (await inspect(bytes)).slides[0]!.slideId;
    const result = await editPresentation(bytes, [nudge({ slideId: id })]);
    expect(result.overflow).toHaveLength(2);
    for (const issue of result.overflow) {
      expect(issue.classification).toBe("uncompared");
      expect(issue).not.toHaveProperty("shapeId");
    }
    const added = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Blank", ref: "new" },
      {
        kind: "addText",
        slideRef: "new",
        x: 40,
        y: 40,
        width: 200,
        height: 20,
        text: "One\nTwo\nThree\nFour\nFive",
      },
    ]);
    expect(added.overflow[0]).toMatchObject({ classification: "uncompared", beforeByPoints: null });
  });

  it("does not compare a slide added after removing the last one with the slide it replaced", async () => {
    const baseline = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Blank", ref: "last" },
      crowded("last"),
    ]);
    const last = baseline.refs.slides.last!;
    const replaced = await editPresentation(baseline.bytes, [
      { kind: "removeSlide", slideId: last },
      { kind: "addSlide", layoutId: "Blank", ref: "fresh" },
      crowded("fresh"),
    ]);
    // Office Kit reuses the removed slide's part name, and may reuse its ID too.
    const fresh = replaced.refs.slides.fresh!;
    expect(replaced.overflow).toEqual([
      expect.objectContaining({
        slideId: fresh,
        classification: "uncompared",
        beforeByPoints: null,
      }),
    ]);
  });

  it("prioritizes changed findings before existing ones and counts all omissions", async () => {
    const draft = await createPresentationDraft();
    const baseline = await editPresentation(
      draft,
      Array.from({ length: 14 }, (_, index) => ({
        kind: "addText",
        slideRef: "first",
        x: 40,
        y: 40,
        width: 200,
        height: 20,
        text: Array.from({ length: 15 + index }, () => "Line").join("\n"),
      })),
    );
    const result = await editPresentation(baseline.bytes, [
      {
        kind: "addText",
        slideRef: "first",
        x: 40,
        y: 40,
        width: 200,
        height: 20,
        text: "One\nTwo\nThree\nFour",
        ref: "new",
      },
    ]);
    expect(result.overflow).toHaveLength(12);
    expect(result.overflow[0]).toMatchObject({
      classification: "new",
      shapeId: result.refs.shapes.new!.shapeId,
    });
    expect(result.overflowSummary).toEqual({
      total: 15,
      omitted: 3,
      counts: { new: 1, increased: 0, existing: 14, uncompared: 0 },
    });
    expect(result.overflow.slice(1).map((issue) => issue.byPoints)).toEqual(
      result.overflow
        .slice(1)
        .map((issue) => issue.byPoints)
        .toSorted((a, b) => b - a),
    );
  });

  it("keeps baseline identity through slide removal and reordering", async () => {
    const baseline = await editPresentation(await createPresentationDraft(), [
      { kind: "addSlide", layoutId: "Blank", ref: "second" },
      { kind: "addSlide", layoutId: "Blank", ref: "third" },
      {
        kind: "addText",
        slideRef: "second",
        x: 40,
        y: 40,
        width: 200,
        height: 20,
        text: "One\nTwo\nThree\nFour",
        ref: "note",
      },
    ]);
    const target = baseline.refs.shapes.note!;
    const result = await editPresentation(baseline.bytes, [
      { kind: "removeSlide", slideId: baseline.inspection.slides[0]!.slideId },
      { kind: "moveSlide", slideId: target.slideId, index: 1 },
      nudge({ slideId: target.slideId }),
    ]);
    expect(result.overflow[0]).toMatchObject({
      ...target,
      classification: "existing",
      beforeByPoints: baseline.overflow[0]!.byPoints,
    });
  });

  it("styles tables and charts with theme colours so they follow the deck's palette", async () => {
    const draft = await createPresentationDraft();
    const edited = await editPresentation(draft, [
      {
        kind: "setText",
        slideRef: "first",
        placeholder: "title",
        text: "Results",
        color: "accent1",
      },
      {
        kind: "addTable",
        slideRef: "first",
        x: 40,
        y: 300,
        width: 400,
        height: 120,
        rows: [
          ["Region", "Q3"],
          ["North", "1,450"],
          ["South", "1,010"],
          ["Total", "2,460"],
        ],
        headerFill: "dark2",
        headerColor: "light1",
        bandFill: "light2",
        borderColor: "none",
        columnWidths: [250, 150],
        columnAlign: ["left", "right"],
        ref: "table",
      },
      {
        kind: "mergeTableCells",
        slideRef: "first",
        shapeRef: "table",
        row: 3,
        column: 0,
        rowSpan: 1,
        columnSpan: 2,
      },
      {
        kind: "addChart",
        slideRef: "first",
        x: 480,
        y: 250,
        width: 400,
        height: 250,
        chartType: "column",
        categories: ["North", "South"],
        series: [{ name: "Q3", values: [1450, 1010], color: "accent2" }],
        numberFormat: "#,##0",
        valueAxisTitle: "Units",
        valueAxisMin: 0,
        gridlines: false,
        textColor: "dark2",
        ref: "chart",
      },
    ]);
    const xml = new TextDecoder().decode(
      readPresentationArchive(edited.bytes).get("ppt/slides/slide1.xml"),
    );
    // Theme names are written as theme slots, not copied hex values.
    expect(xml).toContain('<a:schemeClr val="accent1"/>');
    expect(xml).toContain('<a:schemeClr val="dk2"/>');
    expect(xml).toContain('gridSpan="2"');
    const reread = await loadPresentation(edited.bytes);
    const slide = getSlides(reread)[0]!;
    const table = getSlideShapes(slide).find(
      (shape) => getShapeId(shape) === edited.refs.shapes.table!.shapeId,
    )!;
    expect(getTableColumnWidths(table).map((width) => Math.round(width / 12700))).toEqual([
      250, 150,
    ]);
    const chart = getShapeChartSpec(
      getSlideShapes(slide).find(
        (shape) => getShapeId(shape) === edited.refs.shapes.chart!.shapeId,
      )!,
    )!;
    const theme = getPresentationTheme(reread)!;
    // Charts need concrete colours, so theme names resolve against this deck's theme.
    expect(chart.series[0]!.color?.toUpperCase()).toBe(theme.accent2.toUpperCase());
    expect(chart).toMatchObject({ valueAxisTitle: "Units", valueAxisMajorGridlines: false });
    expect(chart.valueAxis).toMatchObject({ min: 0, numberFormat: "#,##0" });
    await expect(
      editPresentation(draft, [{ kind: "setTheme", accent1: "accent2" }]),
    ).rejects.toThrow(/accent1: expected a #RRGGBB colour/);
  });

  it("recolours the theme and moves only the theme part", async () => {
    const draft = await createPresentationDraft();
    const before = readPresentationArchive(draft);
    const themed = await editPresentation(draft, [
      { kind: "setTheme", accent1: "#112233", headingFont: "Cambria" },
    ]);
    expect((await inspect(themed.bytes)).theme).toMatchObject({
      headingFont: "Cambria",
      colors: { accent1: "#112233" },
    });
    const after = readPresentationArchive(themed.bytes);
    for (const [name, data] of before)
      if (name !== "ppt/theme/theme1.xml") expect(after.get(name)).toEqual(data);
  });

  it("replaces a shape's text without touching other parts", async () => {
    const bytes = await textDeck();
    const original = await inspect(bytes);
    const slide = original.slides[0]!;
    const shape = slide.shapes.find((item) => item.text === "Original")!;
    const changed = await editPresentation(bytes, [
      { kind: "setText", slideId: slide.slideId, shapeId: shape.shapeId, text: "New text" },
    ]);
    expect(
      (await inspect(changed.bytes)).slides[0]?.shapes.find(
        (item) => item.shapeId === shape.shapeId,
      )?.text,
    ).toBe("New text");
    for (const [name, part] of readPresentationArchive(bytes))
      if (name !== "ppt/slides/slide1.xml")
        expect(readPresentationArchive(changed.bytes).get(name)).toEqual(part);
    expect(
      (await inspect(bytes)).slides[0]?.shapes.find((item) => item.shapeId === shape.shapeId)?.text,
    ).toBe("Original");
  });

  it("adds a PNG without modifying existing slide dependencies", async () => {
    const bytes = await textDeck();
    const before = readPresentationArchive(bytes);
    const slideId = (await inspect(bytes)).slides[0]!.slideId;
    const edited = await editPresentation(bytes, [
      { kind: "addImage", slideId, imageRef: picture, x: 42, y: 120, width: 40, height: 40 },
    ]);
    expect(
      (await inspect(edited.bytes)).slides[0]?.shapes.some((shape) => shape.kind === "picture"),
    ).toBe(true);
    const after = readPresentationArchive(edited.bytes);
    expect(
      [...after.keys()].some((name) => name.startsWith("ppt/media/") && name.endsWith(".png")),
    ).toBe(true);
    for (const [name, part] of before)
      if (!name.startsWith("ppt/slides/") && name !== "[Content_Types].xml")
        expect(after.get(name)).toEqual(part);
  });

  it("duplicates and removes ordinary slides without changing surviving dependencies", async () => {
    const bytes = await textDeck();
    const id = (await inspect(bytes)).slides[0]!.slideId;
    const duplicated = await editPresentation(bytes, [{ kind: "duplicateSlide", slideId: id }]);
    expect(duplicated.inspection.slides).toHaveLength(2);
    const removed = await editPresentation(duplicated.bytes, [
      { kind: "removeSlide", slideId: id },
    ]);
    expect(removed.inspection.slides).toHaveLength(1);
    await expect(
      editPresentation(removed.bytes, [
        { kind: "removeSlide", slideId: removed.inspection.slides[0]!.slideId },
      ]),
    ).rejects.toMatchObject({ code: "invalid_operation" });
  });

  it("replaces only the copied slide’s picture when media is shared", async () => {
    const source = await textDeck();
    const originalId = (await inspect(source)).slides[0]!.slideId;
    const inserted = await editPresentation(source, [
      {
        kind: "addImage",
        slideId: originalId,
        imageRef: picture,
        x: 24,
        y: 140,
        width: 80,
        height: 80,
      },
      { kind: "duplicateSlide", slideId: originalId },
    ]);
    const copied = (await inspect(inserted.bytes)).slides[1]!;
    const target = copied.shapes.find((shape) => shape.kind === "picture")!;
    const replacement = (await renderPresentation(source, [originalId]))[0]!.png;
    const before = readPresentationArchive(inserted.bytes);
    const originalMedia = [...before.entries()].filter(([name]) => name.startsWith("ppt/media/"));
    expect(originalMedia).toHaveLength(1);
    const updated = await editPresentation(inserted.bytes, [
      {
        kind: "replaceImage",
        slideId: copied.slideId,
        shapeId: target.shapeId,
        imageRef: replacement,
      },
    ]);
    const after = readPresentationArchive(updated.bytes);
    expect(after.get(originalMedia[0]![0])).toEqual(originalMedia[0]![1]);
    expect(after.get("ppt/slides/slide1.xml")).toEqual(before.get("ppt/slides/slide1.xml"));
    const reopened = await loadPresentation(updated.bytes);
    const originalShape = getSlideShapes(getSlides(reopened)[0]!).find((shape) =>
      getShapeImagePartName(shape),
    )!;
    const changedShape = getSlideShapes(getSlides(reopened)[1]!).find((shape) =>
      getShapeImagePartName(shape),
    )!;
    expect(getShapeImagePartName(originalShape)).not.toBe(getShapeImagePartName(changedShape));
    expect(getShapeImageBytes(originalShape)).toEqual(picture);
    expect(getShapeImageBytes(changedShape)).toEqual(replacement);
    expect(
      (await inspect(updated.bytes)).slides[1]?.shapes.find(
        (shape) => shape.shapeId === target.shapeId,
      )?.bounds,
    ).toEqual(target.bounds);
  });

  it("repoints just one shape when two pictures share a slide rId", async () => {
    const deck = createPresentation();
    const slide = addBlankSlide(deck);
    addSlideImage(slide, picture, { x: pt(10), y: pt(10), w: pt(30), h: pt(30) });
    addSlideImage(slide, picture, { x: pt(50), y: pt(10), w: pt(30), h: pt(30) });
    const saved = await savePresentation(deck);
    const shared = replacePart(saved, "ppt/slides/slide1.xml", (slideXml) => {
      const references = [...slideXml.matchAll(/r:embed="(rId\d+)"/g)];
      expect(references).toHaveLength(2);
      return (
        slideXml.slice(0, references[1]!.index) +
        `r:embed="${references[0]![1]}"` +
        slideXml.slice(references[1]!.index! + references[1]![0].length)
      );
    });
    const inspection = await inspect(shared);
    const id = inspection.slides[0]!.slideId;
    const pictures = inspection.slides[0]!.shapes.filter((shape) => shape.kind === "picture");
    const replacement = (await renderPresentation(saved, [id]))[0]!.png;
    const result = await editPresentation(shared, [
      { kind: "replaceImage", slideId: id, shapeId: pictures[1]!.shapeId, imageRef: replacement },
    ]);
    const reopened = await loadPresentation(result.bytes);
    const shapes = getSlideShapes(getSlides(reopened)[0]!).filter((shape) =>
      getShapeImagePartName(shape),
    );
    expect(getShapeImageBytes(shapes[0]!)).toEqual(picture);
    expect(getShapeImageBytes(shapes[1]!)).toEqual(replacement);
    expect((await inspect(result.bytes)).slides[0]!.shapes.map((shape) => shape.shapeId)).toEqual(
      inspection.slides[0]!.shapes.map((shape) => shape.shapeId),
    );
  });

  it("keeps mixed formatting when replacing within runs, and flattens only on explicit setText", async () => {
    const bytes = await textDeck();
    const mixed = replacePart(bytes, "ppt/slides/slide1.xml", (text) =>
      text.replace(
        "<a:t>Original</a:t>",
        '<a:t>First</a:t></a:r><a:r><a:rPr b="1"/><a:t>Second</a:t>',
      ),
    );
    const slide = (await inspect(mixed)).slides[0]!;
    const shape = slide.shapes.find((item) => item.text === "FirstSecond")!;
    const replaced = await editPresentation(mixed, [
      { kind: "replaceAll", find: "Second", replace: "Last" },
    ]);
    const reread = await loadPresentation(replaced.bytes);
    const runs = getSlideShapes(getSlides(reread)[0]!).find(
      (item) => getShapeId(item) === shape.shapeId,
    )!;
    expect(getShapeRunCount(runs, 0)).toBe(2);
    expect(getShapeRunFormat(runs, 0, 1)?.bold).toBe(true);
    await expect(
      editPresentation(mixed, [{ kind: "replaceAll", find: "absent", replace: "x" }]),
    ).rejects.toMatchObject({ code: "not_found" });
    const flat = await editPresentation(mixed, [
      { kind: "setText", slideId: slide.slideId, shapeId: shape.shapeId, text: "flat" },
    ]);
    expect(
      (await inspect(flat.bytes)).slides[0]!.shapes.find((item) => item.shapeId === shape.shapeId)
        ?.text,
    ).toBe("flat");
  });

  it("rejects malformed package identities, external images, active parts and XML declarations", async () => {
    const bytes = await createPresentationDraft();
    await expect(inspectPresentation(strToU8("not a ZIP"))).rejects.toMatchObject({
      code: "invalid_package",
    });
    await expect(
      inspectPresentation(
        replacePart(bytes, "ppt/presentation.xml", (text) => text.replace('id="256"', 'id="0"')),
      ),
    ).rejects.toMatchObject({ code: "invalid_package" });
    await expect(
      inspectPresentation(
        replacePart(bytes, "ppt/presentation.xml", (text) =>
          text.replace(
            "<p:sldIdLst>",
            "<!DOCTYPE p [<!ENTITY attack SYSTEM 'file:///etc/passwd'>]><p:sldIdLst>",
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_package" });
    await expect(
      inspectPresentation(
        replacePart(bytes, "ppt/_rels/presentation.xml.rels", (text) =>
          text.replace('Target="slides/slide1.xml"', 'Target="../../escape.xml"'),
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_package" });
    await expect(
      inspectPresentation(
        replacePart(bytes, "ppt/slides/_rels/slide1.xml.rels", (text) =>
          text.replace(
            'Target="../slideLayouts/slideLayout2.xml"',
            'Target="https://example.org/logo.png" TargetMode="External"',
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "unsupported_content" });
    const active = readPresentationArchive(bytes);
    active.set("ppt/activeX/activeX1.bin", strToU8("unsafe"));
    await expect(inspectPresentation(zipSync(Object.fromEntries(active)))).rejects.toMatchObject({
      code: "unsupported_content",
    });
    expect(() => parsePresentationOperations([{ kind: "replaceImage", slideId: 256 }])).toThrow(
      "missing imageRef",
    );
    expect(() =>
      parsePresentationOperations([
        { kind: "replaceImage", slideId: 256, shapeId: 2, imageRef: [1, 2] },
      ]),
    ).toThrow("bounded PNG or JPEG");
  });

  it("rejects ZIP expansion bombs and duplicate canonical paths before loading", async () => {
    const bytes = await createPresentationDraft();
    const parts = readPresentationArchive(bytes);
    parts.set("ppt/media/oversized.bin", new Uint8Array(1024 * 1024));
    expect(() => readPresentationArchive(zipSync(Object.fromEntries(parts)))).toThrow(/expansion/i);
    expect(() =>
      readPresentationArchive(
        zipSync({ "ppt/Slide.xml": strToU8("one"), "ppt/slide.xml": strToU8("two") }),
      ),
    ).toThrow(/duplicate/i);
    expect(() => readPresentationArchive(zipSync({ "../bad.xml": strToU8("bad") }))).toThrow(
      /Unsafe/i,
    );
  });

  it.each([
    ["a 12-megapixel JPEG with bytes after its end marker", jpeg(4000, 3000), "jpeg" as const],
    ["a GIF", gif, "gif" as const],
  ])("keeps %s byte for byte and previews it as a placeholder", async (_name, image, format) => {
    const source = await pictureDeck(image, format);
    expect(media(source)[1]).toEqual(image);
    const slideId = (await inspect(source)).slides[0]!.slideId;
    const edited = await editPresentation(source, [nudge({ slideId })]);
    expect(media(edited.bytes)).toEqual(media(source));
    const [rendered] = await renderPresentation(edited.bytes, [slideId]);
    expect(rendered!.png.subarray(0, 8)).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(rendered!.warning).toContain("placeholder");
    // A picture the preview can draw raises no warning.
    const [plain] = await renderPresentation(await textDeck(), [
      (await inspect(await textDeck())).slides[0]!.slideId,
    ]);
    expect(plain!.warning).not.toContain("placeholder");
  });

  it("refuses pictures outside the media folder and relationships under another prefix", async () => {
    const source = await pictureDeck(jpeg(40, 40), "jpeg");
    const parts = readPresentationArchive(source);
    const [name, bytes] = [...parts].find(([part]) => part.startsWith("ppt/media/"))!;
    parts.delete(name);
    parts.set(name.replace("ppt/media/", "ppt/pictures/"), bytes);
    const rels = "ppt/slides/_rels/slide1.xml.rels";
    parts.set(
      rels,
      strToU8(new TextDecoder().decode(parts.get(rels)).replace("../media/", "../pictures/")),
    );
    await expect(inspectPresentation(zipSync(Object.fromEntries(parts)))).rejects.toMatchObject({
      code: "unsupported_content",
      message: expect.stringContaining("outside ppt/media"),
    });
    const renamed = replacePart(source, "ppt/slides/slide1.xml", (xml) =>
      xml
        .replace(/xmlns:r="/, 'xmlns:rel="')
        .replaceAll("r:embed=", "rel:embed=")
        .replaceAll("r:id=", "rel:id="),
    );
    await expect(inspectPresentation(renamed)).rejects.toMatchObject({
      code: "unsupported_content",
    });
  });

  it("refuses two slide entries that point at one slide part", async () => {
    const bytes = await createPresentationDraft();
    const doubled = replacePart(
      replacePart(bytes, "ppt/_rels/presentation.xml.rels", (xml) =>
        xml.replace(
          "</Relationships>",
          '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
        ),
      ),
      "ppt/presentation.xml",
      (xml) => xml.replace("</p:sldIdLst>", '<p:sldId id="9000" r:id="rId99"/></p:sldIdLst>'),
    );
    await expect(inspectPresentation(doubled)).rejects.toMatchObject({
      code: "invalid_package",
      message: expect.stringContaining("Ambiguous slide identity"),
    });
  });

  it("replaces wording in layouts written with numeric character references", async () => {
    const source = await createPresentationDraft();
    const layout = "ppt/slideLayouts/slideLayout1.xml";
    const withFooter = replacePart(source, layout, (xml) =>
      xml.replace(
        "</p:spTree>",
        '<p:sp><p:nvSpPr><p:cNvPr id="90" name="Footer"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Acme&#8217;s &amp; co</a:t></a:r><a:r><a:t>Other&#x2019;s</a:t></a:r></a:p></p:txBody></p:sp></p:spTree>',
      ),
    );
    const edited = await editPresentation(withFooter, [
      { kind: "replaceAll", find: "Acme’s & co", replace: "Beta’s <team>", scope: "everywhere" },
    ]);
    const xml = new TextDecoder().decode(readPresentationArchive(edited.bytes).get(layout));
    expect(xml).toContain("<a:t>Beta’s &lt;team&gt;</a:t>");
    // A run without a match keeps its bytes, references included.
    expect(xml).toContain("<a:t>Other&#x2019;s</a:t>");
    expect(xml).not.toContain("&amp;#");
  });

  it("keeps pie charts to one series and a chart's legend when only its text is restyled", async () => {
    const draft = await createPresentationDraft();
    const charted = await editPresentation(draft, [
      {
        kind: "addChart",
        slideRef: "first",
        x: 40,
        y: 150,
        width: 300,
        height: 200,
        chartType: "pie",
        legend: "bottom",
        categories: ["A", "B"],
        series: [{ name: "Share", values: [1, 2] }],
        ref: "pie",
      },
    ]);
    const target = charted.refs.shapes.pie!;
    await expect(
      editPresentation(charted.bytes, [
        {
          kind: "updateChart",
          ...target,
          categories: ["A", "B"],
          series: [
            { name: "One", values: [1, 2] },
            { name: "Two", values: [3, 4] },
          ],
        },
      ]),
    ).rejects.toThrow(/exactly one series/);
    const restyled = await editPresentation(charted.bytes, [
      {
        kind: "updateChart",
        ...target,
        categories: ["A", "B"],
        series: [{ name: "Share", values: [3, 4] }],
        textColor: "#112233",
      },
    ]);
    const shape = getSlideShapes(getSlides(await loadPresentation(restyled.bytes))[0]!).find(
      (item) => getShapeId(item) === target.shapeId,
    )!;
    expect(getShapeChartSpec(shape)?.legend).toMatchObject({
      position: "b",
      textStyle: { color: "#112233" },
    });
  });
});
