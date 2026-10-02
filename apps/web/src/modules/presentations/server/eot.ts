/**
 * Embedded OpenType, the wrapper PowerPoint reads a deck's `.fntdata` font
 * parts in. Version 0x00020002 with the font data stored whole: no subsetting,
 * no MicroType compression and no XOR, so the font stays editable and the
 * bytes inside are exactly the TrueType file. LibreOffice writes the same.
 */

const EOT_VERSION = 0x0002_0002;
const MAGIC = 0x504c;
const DEFAULT_CHARSET = 1;

interface Tables {
  readonly view: DataView;
  readonly table: (tag: string) => { offset: number; length: number } | undefined;
}

function tablesOf(font: Uint8Array): Tables {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const count = view.getUint16(4);
  const directory = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index++) {
    const at = 12 + index * 16;
    const tag = String.fromCharCode(...font.subarray(at, at + 4));
    directory.set(tag, { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return { view, table: (tag) => directory.get(tag) };
}

/** A name record as UTF-16LE bytes, preferring Windows English; empty when absent. */
function nameBytes({ view, table }: Tables, id: number): Uint8Array {
  const name = table("name");
  if (!name) return new Uint8Array();
  const count = view.getUint16(name.offset + 2);
  const strings = name.offset + view.getUint16(name.offset + 4);
  let best: { offset: number; length: number; rank: number } | null = null;
  for (let index = 0; index < count; index++) {
    const at = name.offset + 6 + index * 12;
    if (view.getUint16(at) !== 3 || view.getUint16(at + 6) !== id) continue;
    const encoding = view.getUint16(at + 2);
    if (encoding !== 1 && encoding !== 0) continue;
    const rank = view.getUint16(at + 4) === 0x409 ? 2 : 1;
    if (!best || rank > best.rank)
      best = {
        offset: strings + view.getUint16(at + 10),
        length: view.getUint16(at + 8),
        rank,
      };
  }
  if (!best) return new Uint8Array();
  // The name table stores UTF-16 big-endian; EOT wants little-endian.
  const out = new Uint8Array(best.length - (best.length % 2));
  for (let index = 0; index < out.length; index += 2) {
    out[index] = view.getUint8(best.offset + index + 1);
    out[index + 1] = view.getUint8(best.offset + index);
  }
  return out;
}

/** What a deck's font list records about a face, read from its OS/2 table. */
export function fontFacts(font: Uint8Array): { panose: string; fixedPitch: boolean } {
  const { view, table } = tablesOf(font);
  const os2 = table("OS/2");
  if (!os2 || os2.length < 42) return { panose: "00000000000000000000", fixedPitch: false };
  const bytes = new Uint8Array(view.buffer, view.byteOffset + os2.offset + 32, 10);
  return {
    panose: [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase(),
    // PANOSE proportion 9 is monospaced for Latin text faces.
    fixedPitch: bytes[0] === 2 && bytes[3] === 9,
  };
}

/** Wraps a TrueType font as an uncompressed EOT, as a `.fntdata` part holds it. */
export function toEot(font: Uint8Array): Uint8Array {
  const tables = tablesOf(font);
  const { view, table } = tables;
  const os2 = table("OS/2");
  const head = table("head");
  const names = [1, 2, 5, 4].map((id) => nameBytes(tables, id));
  const headerSize =
    // Sizes, version, flags, PANOSE, charset, italic, weight, fsType, magic,
    // unicode and code page ranges, checksum adjustment, reserved, padding1.
    4 * 4 +
    10 +
    2 +
    4 +
    2 +
    2 +
    16 +
    8 +
    4 +
    16 +
    2 +
    // Four names, each with its size and the padding before the next.
    names.reduce((total, name) => total + 2 + name.length + 2, 0) +
    // Root string size, its checksum, EUDC code page, padding6, signature
    // size, EUDC flags and EUDC font size, all empty here.
    2 +
    4 +
    4 +
    2 +
    2 +
    4 +
    4;
  const out = new Uint8Array(headerSize + font.length);
  const header = new DataView(out.buffer);
  let at = 0;
  const u8 = (value: number) => header.setUint8(at++, value);
  const u16 = (value: number) => {
    header.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number) => {
    header.setUint32(at, value >>> 0, true);
    at += 4;
  };
  const fromOs2 = (offset: number, size: 2 | 4, minimum: number) =>
    os2 && os2.length >= minimum
      ? size === 2
        ? view.getUint16(os2.offset + offset)
        : view.getUint32(os2.offset + offset)
      : 0;

  u32(out.length);
  u32(font.length);
  u32(EOT_VERSION);
  u32(0);
  for (let index = 0; index < 10; index++)
    u8(os2 && os2.length >= 42 ? view.getUint8(os2.offset + 32 + index) : 0);
  u8(DEFAULT_CHARSET);
  u8(fromOs2(62, 2, 64) & 1);
  u32(fromOs2(4, 2, 6) || 400);
  u16(fromOs2(8, 2, 10));
  u16(MAGIC);
  for (const offset of [42, 46, 50, 54]) u32(fromOs2(offset, 4, offset + 4));
  for (const offset of [78, 82]) u32(fromOs2(offset, 4, offset + 4));
  u32(head && head.length >= 12 ? view.getUint32(head.offset + 8) : 0);
  for (let index = 0; index < 4; index++) u32(0);
  u16(0);
  for (const name of names) {
    u16(name.length);
    out.set(name, at);
    at += name.length;
    u16(0);
  }
  u16(0); // root string size
  u32(0); // root string checksum
  u32(0); // EUDC code page
  u16(0); // padding6
  u16(0); // signature size
  u32(0); // EUDC flags
  u32(0); // EUDC font size
  out.set(font, at);
  return out;
}
