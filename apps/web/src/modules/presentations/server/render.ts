import {
  addSlide,
  addSlideTextBox,
  createPresentation,
  getSlideLayouts,
  getSlidePartName,
  getSlides,
  getSlideSize,
  savePresentation,
  setShapeTextFormat,
} from "@office-kit/pptx";
import { readFileSync } from "node:fs";
import { PRESENTATION_LIMITS } from "../limits.ts";
import { toEmu } from "./content.ts";
import { readFontFile, type FontFace } from "./font-file.ts";
import { loadDerived, openPackage, type Deck } from "./package.ts";
import { fail, toPart } from "./package-xml.ts";
import { previewCopy } from "./preview-copy.ts";

type Preview = typeof import("@office-kit/pptx-preview/node");
export type MeasureText = ReturnType<Preview["buildFontkitMeasurer"]>;

// Loaded once per worker; a persistent worker keeps it warm between tasks.
let preview: Preview | null = null;
export const loadPreview = async () => (preview ??= await import("@office-kit/pptx-preview/node"));

// Building a measurer opens every face; the last one is kept for the next task
// with the same fonts, which in practice is every task.
let measurer: { readonly key: string; readonly measure: MeasureText } | null = null;
const fontsKey = (fonts: readonly FontFace[]) =>
  JSON.stringify(fonts.map((face) => [face.renderFamily, face.path, face.bold, face.italic]));

/**
 * Uploaded faces keep their family instead of the bundled substitute, for
 * drawing and for measuring. The resolver is module state: it is set here for
 * the task at hand and cleared by `resetFonts` when the task ends.
 */
export async function prepareFonts(fonts: readonly FontFace[]) {
  const loaded = await loadPreview();
  const families = new Map(
    fonts.flatMap((face) => [
      [face.family.toLowerCase(), face.renderFamily] as const,
      [face.renderFamily.toLowerCase(), face.renderFamily] as const,
    ]),
  );
  loaded.setFamilyResolver(
    families.size
      ? (family) => (family ? families.get(family.trim().toLowerCase()) : undefined)
      : null,
  );
  const key = fontsKey(fonts);
  if (measurer?.key !== key)
    measurer = {
      key,
      measure: loaded.buildFontkitMeasurer({
        fonts: fonts.map((face) => ({
          family: face.renderFamily,
          source: face.path,
          bold: face.bold,
          italic: face.italic,
        })),
      }),
    };
  return {
    preview: loaded,
    measureText: measurer.measure,
    fontFiles: fonts.map((face) => face.path),
  };
}
export const resetFonts = () => preview?.setFamilyResolver(null);

// A slide over 40 inches a side is not a slide.
const slideSideEmu = 40 * 914400;

export async function renderPresentation(
  bytes: Uint8Array,
  selectedIds: readonly number[],
  fonts: readonly FontFace[] = [],
) {
  if (
    selectedIds.length < 1 ||
    selectedIds.length > PRESENTATION_LIMITS.rendersPerCall ||
    new Set(selectedIds).size !== selectedIds.length
  )
    fail(
      "invalid_operation",
      `Select 1 to ${PRESENTATION_LIMITS.rendersPerCall} distinct slide IDs to render.`,
    );
  const source = await openPackage(bytes);
  const known = new Set(source.ids.values());
  for (const id of selectedIds)
    if (!known.has(id)) fail("not_found", `Slide ${id} does not exist.`);
  const size = getSlideSize(source.deck);
  if (
    !size ||
    size.width <= 0 ||
    size.height <= 0 ||
    size.width > slideSideEmu ||
    size.height > slideSideEmu ||
    Math.ceil((PRESENTATION_LIMITS.renderWidth * size.height) / size.width) *
      PRESENTATION_LIMITS.renderWidth >
      PRESENTATION_LIMITS.renderPixels
  )
    fail("limit", "Slide dimensions exceed the safe render limit.");
  const { preview: loaded, measureText, fontFiles } = await prepareFonts(fonts);
  const copy = previewCopy(source, selectedIds, { files: loaded.FONT_FILES, family: loaded.SANS });
  const deck: Deck = copy.bytes ? await loadDerived(copy.bytes) : source.deck;
  // The copy keeps every slide part name, so the source's identities still apply.
  const byId = new Map(
    getSlides(deck).map((slide) => [source.ids.get(toPart(getSlidePartName(slide))), slide]),
  );
  return selectedIds.map((id) => {
    const png = loaded.renderSlideToImage(deck, byId.get(id)!, {
      width: PRESENTATION_LIMITS.renderWidth,
      measureText,
      fontFiles,
    });
    if (png.length > PRESENTATION_LIMITS.imageBytes)
      fail("limit", "Rendered PNG exceeds the output limit.");
    return {
      slideId: id,
      png,
      warning: `Approximate preview; missing fonts or unsupported PowerPoint effects may differ from Office.${
        copy.placeholders.includes(id)
          ? " Pictures this preview cannot draw show as placeholders; the file keeps them."
          : ""
      }`,
    };
  });
}

/**
 * Validates an uploaded font by reading its tables and rendering a sample with
 * it, so a face the renderer cannot load never reaches the catalogue that every
 * preview uses.
 */
export async function checkFontFile(path: string) {
  const info = readFontFile(new Uint8Array(readFileSync(path)));
  const deck = createPresentation({ size: "16:9" });
  const slide = addSlide(deck, { layout: getSlideLayouts(deck)[0]! });
  const sample = addSlideTextBox(slide, {
    x: toEmu(40),
    y: toEmu(40),
    w: toEmu(600),
    h: toEmu(80),
    text: "The quick brown fox 0123456789",
  });
  setShapeTextFormat(sample, { font: info.family, bold: info.bold, italic: info.italic, size: 32 });
  const bytes = await savePresentation(deck);
  const { ids } = await openPackage(bytes);
  await renderPresentation(bytes, [...ids.values()].slice(0, 1), [{ ...info, path }]);
  return info;
}
