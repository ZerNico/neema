import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  addBlankSlide,
  addSlideImage,
  createPresentation,
  pt,
  savePresentation,
} from "@office-kit/pptx";
import { zipSync } from "fflate";
import { editPresentation, inspectPresentation, renderPresentation } from "./adapter.ts";
import { readPresentationArchive } from "./archive.ts";
import { isSummary } from "./inspection.ts";
import { previewCopy } from "./preview-copy.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const picture = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uAAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><rect width="40" height="40" fill="#e00000"/></svg>';

/** `bitmapFirst` puts an ordinary picture before the SVG one; `slides` adds blank slides after it. */
async function svgDeck(artwork = svg, { bitmapFirst = false, slides = 1 } = {}) {
  const deck = createPresentation();
  const slide = addBlankSlide(deck);
  if (bitmapFirst) addSlideImage(slide, picture, { x: pt(200), y: pt(0), w: pt(40), h: pt(40) });
  addSlideImage(slide, picture, { x: pt(0), y: pt(0), w: pt(40), h: pt(40) });
  for (let extra = 1; extra < slides; extra++) addBlankSlide(deck);
  const parts = readPresentationArchive(await savePresentation(deck));
  const slidePart = "ppt/slides/slide1.xml";
  const slideXml = decoder.decode(parts.get(slidePart)!);
  const blip = [...slideXml.matchAll(/<a:blip\b[^>]*\br:embed=(['"])([^'"]+)\1[^>]*\/>/g)].at(-1);
  if (!blip) throw new Error("Test picture has no self-closing blip.");
  const replacement = `<a:blip><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="rIdSVG"/></a:ext></a:extLst></a:blip>`;
  parts.set(slidePart, encoder.encode(slideXml.replace(blip[0], replacement)));
  const relPart = "ppt/slides/_rels/slide1.xml.rels";
  parts.set(
    relPart,
    encoder.encode(
      decoder
        .decode(parts.get(relPart)!)
        .replace(
          "</Relationships>",
          '<Relationship Id="rIdSVG" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/test-art.svg"/></Relationships>',
        ),
    ),
  );
  parts.set("ppt/media/test-art.svg", encoder.encode(artwork));
  parts.set(
    "[Content_Types].xml",
    encoder.encode(
      decoder
        .decode(parts.get("[Content_Types].xml")!)
        .replace("</Types>", '<Default Extension="svg" ContentType="image/svg+xml"/></Types>'),
    ),
  );
  return zipSync(Object.fromEntries(parts));
}

describe("PowerPoint SVG artwork", () => {
  it("inspects, edits and previews SVG-only pictures without changing the vector asset", async () => {
    const source = await svgDeck();
    const [before] = (await inspectPresentation(source, { slides: "all", shapes: true })).slides;
    const slideId = before!.slideId;
    expect(
      before && isSummary(before) && before.shapes?.some((shape) => shape.kind === "picture"),
    ).toBe(true);
    const rendered = await renderPresentation(source, [slideId]);
    expect(rendered[0]!.png.subarray(0, 8)).toEqual(
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const withoutArtwork = readPresentationArchive(source);
    withoutArtwork.set(
      "ppt/slides/slide1.xml",
      encoder.encode(
        decoder
          .decode(withoutArtwork.get("ppt/slides/slide1.xml")!)
          .replace(/<a:extLst>[\s\S]*?<\/a:extLst>/, ""),
      ),
    );
    const [placeholder] = await renderPresentation(zipSync(Object.fromEntries(withoutArtwork)), [
      slideId,
    ]);
    expect(rendered[0]!.png).not.toEqual(placeholder!.png);
    const result = await editPresentation(source, [
      { kind: "addText", slideId, text: "SVG preserved", x: 100, y: 100, width: 180, height: 30 },
    ]);
    const sourceParts = readPresentationArchive(source);
    const editedParts = readPresentationArchive(result.bytes);
    expect(editedParts.get("ppt/media/test-art.svg")).toEqual(
      sourceParts.get("ppt/media/test-art.svg"),
    );
    expect(decoder.decode(editedParts.get("ppt/slides/slide1.xml"))).toContain("svgBlip");
    expect([...editedParts.keys()].filter((name) => name.includes("preview-svg"))).toEqual([]);
    expect((await renderPresentation(result.bytes, [slideId]))[0]!.png.length).toBeGreaterThan(
      1000,
    );
  });

  it("round-trips an associated-template handle without changing SVG bytes or slide artwork", async () => {
    const source = await svgDeck();
    const parts = readPresentationArchive(source);
    const layoutId = (await inspectPresentation(source)).slides[0]!.layoutId!;
    const layout = layoutId.slice(1);
    const pictureXml = decoder
      .decode(parts.get("ppt/slides/slide1.xml"))
      .match(/<p:pic>[\s\S]*?<\/p:pic>/)![0]
      .replace(/<p:cNvPr id="\d+"/, '<p:cNvPr id="90"');
    parts.set(
      layout,
      encoder.encode(
        decoder.decode(parts.get(layout)).replace("</p:spTree>", `${pictureXml}</p:spTree>`),
      ),
    );
    const rels = layout.replace(/\/([^/]+)$/, "/_rels/$1.rels");
    parts.set(
      rels,
      encoder.encode(
        decoder
          .decode(parts.get(rels))
          .replace(
            "</Relationships>",
            '<Relationship Id="rIdSVG" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/test-art.svg"/></Relationships>',
          ),
      ),
    );
    const bytes = zipSync(Object.fromEntries(parts));
    const inspected = await inspectPresentation(bytes, { slides: "all", owners: true });
    const owner = inspected.templateOwners.find((entry) => entry.templateId === layoutId)!;
    const candidate = owner.targets.find((shape) => shape.shapeId === 90)!;
    expect(candidate.kind).toBe("picture");
    const edited = await editPresentation(bytes, [
      { kind: "removeShape", templateId: owner.templateId, shapeId: candidate.shapeId },
    ]);
    const after = readPresentationArchive(edited.bytes);
    expect(after.get("ppt/media/test-art.svg")).toEqual(parts.get("ppt/media/test-art.svg"));
    expect(after.get("ppt/slides/slide1.xml")).toEqual(parts.get("ppt/slides/slide1.xml"));
    expect(
      edited.inspection.templateOwners.find((entry) => entry.templateId === layoutId)!.targets,
    ).toEqual([]);
    expect(
      (await renderPresentation(edited.bytes, [inspected.slides[0]!.slideId]))[0]!.png.length,
    ).toBeGreaterThan(1000);
  });

  it("draws SVG-only artwork that follows an ordinary bitmap picture", async () => {
    const source = await svgDeck(svg, { bitmapFirst: true });
    const slideId = (await inspectPresentation(source)).slides[0]!.slideId;
    const [rendered] = await renderPresentation(source, [slideId]);
    const withoutArtwork = readPresentationArchive(source);
    withoutArtwork.set(
      "ppt/slides/slide1.xml",
      encoder.encode(
        decoder
          .decode(withoutArtwork.get("ppt/slides/slide1.xml")!)
          .replace(/<a:extLst>[\s\S]*?<\/a:extLst>/, ""),
      ),
    );
    const [placeholder] = await renderPresentation(zipSync(Object.fromEntries(withoutArtwork)), [
      slideId,
    ]);
    expect(rendered!.png).not.toEqual(placeholder!.png);
  });

  it("drops the content type of a slide removed from an SVG deck", async () => {
    const source = await svgDeck(svg, { slides: 2 });
    const [, second] = (await inspectPresentation(source)).slides;
    const result = await editPresentation(source, [
      { kind: "removeSlide", slideId: second!.slideId },
    ]);
    const parts = readPresentationArchive(result.bytes);
    const types = decoder.decode(parts.get("[Content_Types].xml")!);
    const named = [...types.matchAll(/PartName="\/([^"]+)"/g)].map((match) => match[1]!);
    expect(named.filter((part) => !parts.has(part))).toEqual([]);
    expect(types).toContain('Extension="svg"');
  });

  it("keeps prefixed relationship entries in the preview package namespace", async () => {
    const source = await svgDeck();
    const slideId = (await inspectPresentation(source)).slides[0]!.slideId;
    const parts = readPresentationArchive(source);
    const relPart = "ppt/slides/_rels/slide1.xml.rels";
    const original = decoder.decode(parts.get(relPart)!);
    parts.set(
      relPart,
      encoder.encode(
        original
          .replace(
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
            '<ns0:Relationships xmlns:ns0="http://schemas.openxmlformats.org/package/2006/relationships">',
          )
          .replaceAll("<Relationship ", "<ns0:Relationship ")
          .replace("</Relationships>", "</ns0:Relationships>"),
      ),
    );
    const copy = previewCopy(
      {
        parts,
        ids: new Map([["ppt/slides/slide1.xml", slideId]]),
        rels: new Map([
          [
            relPart,
            new Map([
              [
                "rIdSVG",
                {
                  target: "ppt/media/test-art.svg",
                  type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
                },
              ],
            ]),
          ],
        ]),
      },
      [slideId],
      { files: [], family: "Carlito" },
    );
    expect(copy.bytes).not.toBeNull();
    const rels = decoder.decode(readPresentationArchive(copy.bytes!).get(relPart)!);
    expect(rels).toContain('<ns0:Relationship Id="rIdPreview1"');
    expect(rels).not.toContain('<Relationship Id="rIdPreview1"');
  });

  it("rejects a direct SVG picture or a falsely typed SVG part", async () => {
    const source = await svgDeck();
    const direct = readPresentationArchive(source);
    direct.set(
      "ppt/slides/slide1.xml",
      encoder.encode(
        decoder
          .decode(direct.get("ppt/slides/slide1.xml")!)
          .replace(/<a:blip>[\s\S]*?<\/a:blip>/, '<a:blip r:embed="rIdSVG"/>'),
      ),
    );
    await expect(inspectPresentation(zipSync(Object.fromEntries(direct)))).rejects.toMatchObject({
      code: "unsupported_content",
    });
    const wrongType = readPresentationArchive(source);
    wrongType.set(
      "[Content_Types].xml",
      encoder.encode(
        decoder
          .decode(wrongType.get("[Content_Types].xml")!)
          .replace(
            'Extension="svg" ContentType="image/svg+xml"',
            'Extension="svg" ContentType="text/plain"',
          ),
      ),
    );
    await expect(inspectPresentation(zipSync(Object.fromEntries(wrongType)))).rejects.toMatchObject(
      {
        code: "unsupported_content",
      },
    );
  });

  it("draws a typical Illustrator export", async () => {
    const source = await svgDeck(`<?xml version="1.0" encoding="utf-8"?>
<!-- Generator: Adobe Illustrator 27.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->
<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px"
	 viewBox="0 0 40 40" style="enable-background:new 0 0 40 40;" xml:space="preserve">
<style type="text/css">.st0{fill:#E00000;}</style>
<rect class="st0" width="40" height="40"/>
</svg>`);
    const slideId = (await inspectPresentation(source)).slides[0]!.slideId;
    const [rendered] = await renderPresentation(source, [slideId]);
    expect(rendered!.warning).not.toContain("placeholder");
  });

  const fanOut = (depth: number) =>
    `<defs><rect id="l0" width="1" height="1"/>${Array.from(
      { length: depth },
      (_, index) => `<g id="l${index + 1}"><use href="#l${index}"/><use href="#l${index}"/></g>`,
    ).join("")}</defs><use href="#l${depth}"/>`;
  it.each([
    ["an external reference", '<use href="https://example.org/logo.svg#logo"/>'],
    ["an embedded image", '<image href="data:image/png;base64,AAAA" width="4" height="4"/>'],
    ["a foreign object", "<foreignObject/>"],
    ["a costly filter primitive", '<filter id="f"><feTurbulence baseFrequency="0.1"/></filter>'],
    ["exponential reuse", fanOut(16)],
    [
      "too many filter applications",
      `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><defs><filter id="f"><feGaussianBlur stdDeviation="4"/></filter></defs>${'<rect filter="url(#f)" width="640" height="640"/>'.repeat(50)}</svg>`,
    ],
    ["a reference cycle", '<g id="a"><use href="#a"/></g>'],
    [
      "paint servers applied from a style sheet",
      `<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><style>.a{fill:url(#g)}</style>${'<rect class="a" width="40" height="40"/>'.repeat(4)}`,
    ],
  ])("keeps artwork with %s but previews it as a placeholder", async (_name, body) => {
    const artwork = body.startsWith("<svg")
      ? body
      : `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">${body}</svg>`;
    const source = await svgDeck(artwork);
    const slideId = (await inspectPresentation(source)).slides[0]!.slideId;
    const [rendered] = await renderPresentation(source, [slideId]);
    expect(rendered!.warning).toContain("placeholder");
    const result = await editPresentation(source, [
      { kind: "addText", slideId, text: "Kept", x: 100, y: 100, width: 100, height: 30 },
    ]);
    expect(
      decoder.decode(readPresentationArchive(result.bytes).get("ppt/media/test-art.svg")),
    ).toBe(artwork);
  });

  it("draws SVG text with the bundled faces rather than dropping it", async () => {
    const words = await svgDeck(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="10" y="45" font-size="40" fill="#000">Hello</text></svg>',
    );
    const blank = await svgDeck(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><g/></svg>',
    );
    const slideId = (await inspectPresentation(words)).slides[0]!.slideId;
    const [withText] = await renderPresentation(words, [slideId]);
    const [without] = await renderPresentation(blank, [slideId]);
    expect(withText!.warning).not.toContain("placeholder");
    expect(withText!.png).not.toEqual(without!.png);
  });

  it("previews an SVG deck that expands past the compressed input limit", async () => {
    const parts = readPresentationArchive(await svgDeck());
    // Hex text compresses about twofold: under the input limit, well over it expanded.
    parts.set(
      "ppt/media/padding.png",
      encoder.encode(randomBytes(13 * 1024 * 1024).toString("hex")),
    );
    const bytes = zipSync(Object.fromEntries(parts));
    expect(bytes.length).toBeLessThan(20 * 1024 * 1024);
    const slideId = (await inspectPresentation(bytes)).slides[0]!.slideId;
    const [rendered] = await renderPresentation(bytes, [slideId]);
    expect(rendered!.warning).not.toContain("placeholder");
  }, 60_000);
});
