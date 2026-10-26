import { FONT_LIMITS } from "../limits.ts";
import { PresentationError } from "../errors.ts";

/** What an uploaded font calls itself, read from its own tables. */
export interface FontFileInfo {
  /** The family PowerPoint writes in a deck (name ID 1), e.g. "Montserrat SemiBold". */
  readonly family: string;
  /** The family the rasterizer matches (typographic name ID 16, else ID 1). */
  readonly renderFamily: string;
  readonly style: string;
  readonly bold: boolean;
  readonly italic: boolean;
  /**
   * Whether the font's licence bits let a document carry it editably: a
   * TrueType face marked installable or editable. Preview-only, restricted
   * and bitmap-only faces would leave recipients unable to edit.
   */
  readonly embeddable: boolean;
  readonly format: "ttf" | "otf";
}

/** A face the renderer may use, materialized to a local file. */
export interface FontFace {
  readonly family: string;
  readonly renderFamily: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly path: string;
  /** Who supplied it; for one family and style an upload wins, then a skill, then Google. */
  readonly source: "upload" | "skill" | "google";
  /** Whether decks that use it carry it: licence allowing, always for Google, by admin choice for uploads. */
  readonly embed?: boolean;
}

const printable = (text: string) =>
  text.length > 0 &&
  text.length <= 100 &&
  ![...text].some((character) => character.charCodeAt(0) < 32 || '<>&"'.includes(character));
/** `code` names the refusals an uploader can act on, so the upload can word them for its reader. */
const invalid = (message: string, code: FontRefusal = "invalid_font"): never => {
  throw new PresentationError(code, message);
};
export type FontRefusal =
  | "invalid_font"
  | "not_a_font"
  | "font_collection"
  | "web_font"
  | "variable_font";

/**
 * Reads the name, OS/2 and head tables of a single TrueType or OpenType font.
 * Collections and web fonts are refused; whether the glyph data renders is
 * proven separately by a trial render.
 */
export function readFontFile(bytes: Uint8Array): FontFileInfo {
  if (bytes.length < 12 || bytes.length > FONT_LIMITS.fileBytes)
    return invalid(
      `A font file must be a TrueType or OpenType file under ${Math.round(FONT_LIMITS.fileBytes / 1024 / 1024)} MB.`,
      "not_a_font",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  const signature = tag(0);
  const format =
    view.getUint32(0) === 0x00010000 || signature === "true"
      ? ("ttf" as const)
      : signature === "OTTO"
        ? ("otf" as const)
        : signature === "ttcf"
          ? invalid(
              "Font collections (.ttc) aren't supported; upload each face as .ttf or .otf.",
              "font_collection",
            )
          : signature === "wOFF" || signature === "wOF2"
            ? invalid(
                "Web fonts (.woff) aren't supported; upload the .ttf or .otf version.",
                "web_font",
              )
            : invalid("This is not a TrueType or OpenType font.", "not_a_font");
  const count = view.getUint16(4);
  if (count < 1 || count > 200 || 12 + count * 16 > bytes.length)
    return invalid("The font's table directory is malformed.");
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    if (offset + length > bytes.length) return invalid("The font's tables run past its end.");
    tables.set(tag(at), { offset, length });
  }
  const name = tables.get("name");
  const os2 = tables.get("OS/2");
  const head = tables.get("head");
  if (!name || !head) return invalid("The font has no name or head table.");

  const names = new Map<number, string>();
  const records = view.getUint16(name.offset + 2);
  const strings = name.offset + view.getUint16(name.offset + 4);
  for (let index = 0; index < records && index < 500; index++) {
    const at = name.offset + 6 + index * 12;
    if (at + 12 > name.offset + name.length) break;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const language = view.getUint16(at + 4);
    const id = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const start = strings + view.getUint16(at + 10);
    if (![1, 2, 16, 17].includes(id) || start + length > bytes.length) continue;
    const raw = bytes.subarray(start, start + length);
    // Windows English names first, then any Windows name, then Macintosh Roman.
    const rank =
      platform === 3 && language === 0x409
        ? 3
        : platform === 3
          ? 2
          : platform === 1 && encoding === 0
            ? 1
            : 0;
    if (!rank) continue;
    const text =
      platform === 3 ? new TextDecoder("utf-16be").decode(raw) : String.fromCharCode(...raw);
    const key = id * 10 + rank;
    names.set(key, text.trim());
  }
  const best = (id: number) =>
    names.get(id * 10 + 3) ?? names.get(id * 10 + 2) ?? names.get(id * 10 + 1);
  const family = best(1);
  if (!family || !printable(family)) return invalid("The font has no usable family name.");
  const typographic = best(16);
  const renderFamily = typographic && printable(typographic) ? typographic : family;

  checkOutlines(view, tables, format);

  const macStyle = head.length >= 46 ? view.getUint16(head.offset + 44) : 0;
  const weight = os2 && os2.length >= 6 ? view.getUint16(os2.offset + 4) : 400;
  const fsType = os2 && os2.length >= 10 ? view.getUint16(os2.offset + 8) : 0;
  const selection = os2 && os2.length >= 64 ? view.getUint16(os2.offset + 62) : 0;
  return {
    family,
    renderFamily,
    style: best(17) ?? best(2) ?? "Regular",
    bold: (selection & 0x20) !== 0 || (macStyle & 1) !== 0 || weight >= 700,
    italic: (selection & 0x201) !== 0 || (macStyle & 2) !== 0,
    // Usage bits 0 (installable) or 8 (editable), not bitmap-only (0x200).
    embeddable:
      format === "ttf" &&
      ((fsType & 0x000f) === 0 || (fsType & 0x000f) === 0x0008) &&
      !(fsType & 0x0200),
    format,
  };
}

type Tables = ReadonlyMap<string, { readonly offset: number; readonly length: number }>;

/**
 * Bounds what drawing any glyph can cost, from the outlines themselves. The
 * renderer is native code a timeout cannot interrupt, so a face whose glyphs
 * are pathological is refused before it can reach a preview.
 */
function checkOutlines(view: DataView, tables: Tables, format: "ttf" | "otf") {
  if (tables.has("CFF2")) return invalid("Variable CFF2 fonts aren't supported.", "variable_font");
  const maxp = tables.get("maxp");
  if (!maxp || maxp.length < 6) return invalid("The font has no glyph count.");
  const glyphs = view.getUint16(maxp.offset + 4);
  if (glyphs < 1) return invalid("The font has no glyphs.");
  if (format === "otf") return checkCharStrings(view, tables, glyphs);

  const glyf = tables.get("glyf");
  const loca = tables.get("loca");
  const head = tables.get("head")!;
  if (!glyf || !loca || head.length < 54) return invalid("The font has no glyph outlines.");
  const long = view.getInt16(head.offset + 50) === 1;
  if (loca.length < (glyphs + 1) * (long ? 4 : 2))
    return invalid("The font's glyph index is short.");
  const at = (index: number) =>
    long ? view.getUint32(loca.offset + index * 4) : view.getUint16(loca.offset + index * 2) * 2;
  const own = new Uint32Array(glyphs);
  const parts: number[][] = Array.from({ length: glyphs }, () => []);
  for (let glyph = 0; glyph < glyphs; glyph++) {
    const start = at(glyph);
    const end = at(glyph + 1);
    if (end < start || end > glyf.length) return invalid("The font's glyph offsets are malformed.");
    if (end === start) continue;
    if (end - start < 10) return invalid("A glyph in the font is truncated.");
    const base = glyf.offset + start;
    const contours = view.getInt16(base);
    if (contours >= 0) {
      if (contours > 0) {
        if (10 + contours * 2 > end - start) return invalid("A glyph in the font is truncated.");
        own[glyph] = view.getUint16(base + 10 + (contours - 1) * 2) + 1;
      }
      continue;
    }
    // A composite: other glyphs placed with offsets and optional scales.
    let cursor = base + 10;
    for (let more = true; more;) {
      if (cursor + 4 > glyf.offset + end) return invalid("A composite glyph is truncated.");
      const flags = view.getUint16(cursor);
      const child = view.getUint16(cursor + 2);
      if (child >= glyphs) return invalid("A composite glyph names a missing glyph.");
      parts[glyph]!.push(child);
      if (parts[glyph]!.length > FONT_LIMITS.componentsPerGlyph)
        return invalid("A composite glyph has too many parts.");
      cursor +=
        4 +
        (flags & 0x0001 ? 4 : 2) +
        (flags & 0x0008 ? 2 : flags & 0x0040 ? 4 : flags & 0x0080 ? 8 : 0);
      more = (flags & 0x0020) !== 0;
    }
  }
  // Composites resolve to the points they draw; a cycle or a deep tree is refused.
  const points = new Float64Array(glyphs).fill(-1);
  const resolve = (glyph: number, depth: number): number => {
    if (depth > FONT_LIMITS.compositeDepth) return invalid("A composite glyph nests too deeply.");
    if (points[glyph]! >= 0) return points[glyph]!;
    const children = parts[glyph]!;
    const total = children.length
      ? children.reduce((sum, child) => sum + resolve(child, depth + 1), 0)
      : own[glyph]!;
    if (total > FONT_LIMITS.pointsPerGlyph)
      return invalid("A glyph in the font is too complex to draw safely.");
    points[glyph] = total;
    return total;
  };
  for (let glyph = 0; glyph < glyphs; glyph++) resolve(glyph, 0);
}

/**
 * CFF outlines are programs: each glyph's charstring must be indexed and
 * bounded. Subroutine calls can still repeat work; the renderer's kill timeout
 * is what bounds those.
 */
function checkCharStrings(view: DataView, tables: Tables, glyphs: number) {
  const cff = tables.get("CFF ");
  if (!cff || cff.length < 4) return invalid("The font has no glyph outlines.");
  const end = cff.offset + cff.length;
  const offsetOf = (at: number, size: number) => {
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + view.getUint8(at + i);
    return value;
  };
  /** An INDEX's items as [start, end) pairs, and where the next structure begins. */
  const index = (at: number) => {
    if (at + 2 > end) return invalid("The font's outline table is truncated.");
    const count = view.getUint16(at);
    if (count === 0) return { items: [] as Array<[number, number]>, next: at + 2 };
    const size = view.getUint8(at + 2);
    if (size < 1 || size > 4 || at + 3 + (count + 1) * size > end)
      return invalid("The font's outline table is malformed.");
    const data = at + 2 + (count + 1) * size;
    const items: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      const from = data + offsetOf(at + 3 + i * size, size);
      const to = data + offsetOf(at + 3 + (i + 1) * size, size);
      if (to < from || to > end + 1) return invalid("The font's outline table is malformed.");
      items.push([from, to]);
    }
    return { items, next: data + offsetOf(at + 3 + count * size, size) };
  };
  const names = index(cff.offset + view.getUint8(cff.offset + 2));
  const top = index(names.next);
  const dict = top.items[0];
  if (!dict) return invalid("The font's outline table has no top dictionary.");
  // Operator 17 in the top dictionary is the CharStrings INDEX offset.
  let charStrings: number | null = null;
  const operands: number[] = [];
  for (let cursor = dict[0]; cursor < dict[1];) {
    const byte = view.getUint8(cursor);
    if (byte <= 21) {
      if (byte === 17) charStrings = operands.at(-1) ?? null;
      operands.length = 0;
      cursor += byte === 12 ? 2 : 1;
    } else if (byte === 28) {
      operands.push(view.getInt16(cursor + 1));
      cursor += 3;
    } else if (byte === 29) {
      operands.push(view.getInt32(cursor + 1));
      cursor += 5;
    } else if (byte === 30) {
      // A real number: nibbles until one is 0xf.
      cursor += 1;
      while (cursor < dict[1] && (view.getUint8(cursor++) & 0x0f) !== 0x0f);
      operands.push(0);
    } else if (byte >= 32 && byte <= 246) {
      operands.push(byte - 139);
      cursor += 1;
    } else if (byte >= 247 && byte <= 250) {
      operands.push((byte - 247) * 256 + view.getUint8(cursor + 1) + 108);
      cursor += 2;
    } else if (byte >= 251 && byte <= 254) {
      operands.push(-(byte - 251) * 256 - view.getUint8(cursor + 1) - 108);
      cursor += 2;
    } else return invalid("The font's outline table is malformed.");
  }
  if (charStrings === null || charStrings <= 0) return invalid("The font has no glyph outlines.");
  const { items } = index(cff.offset + charStrings);
  if (items.length !== glyphs) return invalid("The font's outlines don't match its glyph count.");
  for (const [from, to] of items)
    if (to - from > FONT_LIMITS.charStringBytes)
      return invalid("A glyph in the font is too complex to draw safely.");
}
