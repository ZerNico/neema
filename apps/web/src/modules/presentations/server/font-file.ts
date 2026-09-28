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
  /** False when the font's licence bits forbid embedding it in documents. */
  readonly embeddable: boolean;
  readonly format: "ttf" | "otf";
}

/** An uploaded face the renderer may use, materialized to a local file. */
export interface FontFace {
  readonly family: string;
  readonly renderFamily: string;
  readonly bold: boolean;
  readonly italic: boolean;
  readonly path: string;
}

const printable = (text: string) =>
  text.length > 0 &&
  text.length <= 100 &&
  ![...text].some((character) => character.charCodeAt(0) < 32 || '<>&"'.includes(character));
const invalid = (message: string): never => {
  throw new PresentationError("invalid_font", message);
};

/**
 * Reads the name, OS/2 and head tables of a single TrueType or OpenType font.
 * Collections and web fonts are refused; whether the glyph data renders is
 * proven separately by a trial render.
 */
export function readFontFile(bytes: Uint8Array): FontFileInfo {
  if (bytes.length < 12 || bytes.length > FONT_LIMITS.fileBytes)
    return invalid(
      `A font file must be a TrueType or OpenType file under ${Math.round(FONT_LIMITS.fileBytes / 1024 / 1024)} MB.`,
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
          ? invalid("Font collections (.ttc) aren't supported; upload each face as .ttf or .otf.")
          : signature === "wOFF" || signature === "wOF2"
            ? invalid("Web fonts (.woff) aren't supported; upload the .ttf or .otf version.")
            : invalid("This is not a TrueType or OpenType font.");
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
    // Bit 1 alone is "restricted licence": no embedding at all.
    embeddable: (fsType & 0x000f) !== 0x0002,
    format,
  };
}
