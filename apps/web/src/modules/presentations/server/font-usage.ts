import type { FontFace } from "./font-file.ts";
import type { Parts } from "./package-xml.ts";

// Every part whose text a preview or PowerPoint draws: the theme's fonts,
// slides, their layouts and masters, notes, and charts.
const DRAWN_PART = /^ppt\/(theme|slides|slideLayouts|slideMasters|notesSlides|charts)\/[^/]+\.xml$/;
const TYPEFACE = /<(?:[\w-]+:)?(?:latin|ea|cs)\b[^>]*?\btypeface="([^"]*)"/g;

/** Every operation field that names a typeface, chart text included. */
export const FONT_FIELDS = new Set(["font", "headingFont", "bodyFont", "textFont"]);

const unescape = (value: string) =>
  value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");

/**
 * The typefaces a deck names, lowercased. Theme references (+mj-lt, +mn-lt)
 * resolve through the theme part, whose own names are read here too.
 */
export function deckTypefaces(parts: Parts): Set<string> {
  const decoder = new TextDecoder();
  const names = new Set<string>();
  for (const [name, bytes] of parts) {
    if (!DRAWN_PART.test(name)) continue;
    for (const [, raw] of decoder.decode(bytes).matchAll(TYPEFACE)) {
      const typeface = unescape(raw ?? "").trim();
      if (typeface && !typeface.startsWith("+")) names.add(typeface.toLowerCase());
    }
  }
  return names;
}

/** Typefaces an edit's operations name, which the deck may not use yet. */
export function operationTypefaces(operations: unknown): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object" && !(value instanceof Uint8Array))
      for (const [key, item] of Object.entries(value))
        if (FONT_FIELDS.has(key) && typeof item === "string") names.add(item.trim().toLowerCase());
        else visit(item);
  };
  visit(operations);
  return names;
}

/**
 * Only the faces a job's text can use. Every face handed to the renderer is
 * opened for every slide and also becomes a glyph fallback, so a cache of
 * fetched families would otherwise cost every preview.
 */
export const facesFor = (fonts: readonly FontFace[], typefaces: ReadonlySet<string>) =>
  fonts.filter(
    (face) =>
      typefaces.has(face.family.toLowerCase()) || typefaces.has(face.renderFamily.toLowerCase()),
  );
