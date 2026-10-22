import { crc32 } from "node:zlib";
import { exifOrientation, tiffOrientation, u16be, u32be } from "./image-header.ts";

// A person's photo carries where and when it was taken and what took it, for
// every provider and downloader, while a model reads only pixels. Segments that
// describe are dropped and those that draw kept, without decoding. A turned
// photo keeps only its orientation.

const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...b.subarray(at, at + length));

const joined = (parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Big-endian TIFF data whose one IFD entry is the orientation. */
const orientationTiff = (orientation: number) => [
  0x4d,
  0x4d,
  0x00,
  0x2a,
  ...be32(8),
  ...be16(1),
  0x01,
  0x12,
  0x00,
  0x03,
  ...be32(1),
  ...be16(orientation),
  0,
  0,
  ...be32(0),
];

const reoriented = (orientation: number | null): orientation is number =>
  orientation !== null && orientation >= 2 && orientation <= 8;

// APP0 (JFIF), APP2 when it is the colour profile, APP14 (Adobe's colour
// transform); every other APPn and comments describe rather than draw.
const keepsJpegSegment = (b: Uint8Array, at: number, marker: number) =>
  marker === 0xe0 ||
  marker === 0xee ||
  (marker === 0xe2 && ascii(b, at + 4, 12) === "ICC_PROFILE\0") ||
  (marker !== 0xfe && (marker < 0xe0 || marker > 0xef));

function jpeg(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let orientation: number | null = null;
  let at = 2;
  while (at + 1 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === 0xd9) {
      // Anything after the end of the image (thumbnails, a motion photo's video) goes too.
      out.push(b.subarray(at, at + 2));
      if (reoriented(orientation)) {
        const tiff = orientationTiff(orientation);
        const segment = Uint8Array.from([
          0xff,
          0xe1,
          ...be16(8 + tiff.length),
          0x45,
          0x78,
          0x69,
          0x66,
          0,
          0,
          ...tiff,
        ]);
        // After JFIF's APP0 when there is one, which must come first.
        const jfif = out[1]?.[1] === 0xe0 ? 2 : 1;
        out.splice(jfif, 0, segment);
      }
      return joined(out);
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(b.subarray(at, at + 2));
      at += 2;
      continue;
    }
    if (at + 4 > b.length) return null;
    const end = at + 2 + u16be(b, at + 2);
    if (end < at + 4 || end > b.length) return null;
    if (marker === 0xda) {
      // The scan runs to the next marker that is neither stuffing nor a restart.
      let next = end;
      while (
        next + 1 < b.length &&
        !(b[next] === 0xff && b[next + 1] !== 0 && (b[next + 1]! < 0xd0 || b[next + 1]! > 0xd7))
      )
        next++;
      if (next + 1 >= b.length) return null;
      out.push(b.subarray(at, next));
      at = next;
      continue;
    }
    if (marker === 0xe1 && orientation === null) orientation = exifOrientation(b, at, end);
    if (keepsJpegSegment(b, at, marker)) out.push(b.subarray(at, end));
    at = end;
  }
  return null;
}

// Ancillary chunks that change how the picture is drawn, animation included.
// Critical chunks (an uppercase first letter) are always kept.
const PNG_DRAWING = new Set([
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCV",
  "cLLI",
  "bKGD",
  "pHYs",
  "sPLT",
  "hIST",
  "acTL",
  "fcTL",
  "fdAT",
]);

function png(b: Uint8Array): Uint8Array | null {
  const out: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= b.length) {
    const end = at + 12 + u32be(b, at);
    if (end > b.length) return null;
    const type = ascii(b, at + 4, 4);
    if (type === "eXIf") {
      const orientation = tiffOrientation(b, at + 8, end - 4);
      if (reoriented(orientation)) {
        const body = [..."eXIf"].map((c) => c.charCodeAt(0)).concat(orientationTiff(orientation));
        out.push(
          Uint8Array.from([
            ...be32(body.length - 4),
            ...body,
            ...be32(crc32(Uint8Array.from(body))),
          ]),
        );
      }
    } else if (type[0]! < "a" || PNG_DRAWING.has(type)) out.push(b.subarray(at, end));
    if (type === "IEND") return joined(out);
    at = end;
  }
  return null;
}

function webp(b: Uint8Array): Uint8Array | null {
  // Only the extended format has room for metadata.
  if (b.length < 30 || ascii(b, 12, 4) !== "VP8X") return b;
  const out: Uint8Array[] = [];
  let kept = false;
  let at = 12;
  while (at + 8 <= b.length) {
    const size = b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | ((b[at + 7]! << 24) >>> 0);
    const end = Math.min(at + 8 + size + (size & 1), b.length);
    if (at + 8 + size > b.length) return null;
    const type = ascii(b, at, 4);
    if (type === "EXIF") {
      // Some writers put JPEG's "Exif\0\0" before the TIFF data.
      const tiff = ascii(b, at + 8, 6) === "Exif\0\0" ? at + 14 : at + 8;
      const orientation = tiffOrientation(b, tiff, at + 8 + size);
      if (reoriented(orientation)) {
        const data = orientationTiff(orientation);
        out.push(Uint8Array.from([0x45, 0x58, 0x49, 0x46, ...le32(data.length), ...data]));
        kept = true;
      }
    } else if (type !== "XMP ") out.push(b.subarray(at, end));
    at = end;
  }
  const body = joined([b.subarray(0, 12), ...out]);
  // The header's flags promise EXIF (bit 3) only for a kept orientation, XMP
  // (bit 2) never, and its size is the new one.
  body[20] = (body[20]! & ~0x0c) | (kept ? 0x08 : 0);
  body.set(le32(body.length - 8), 4);
  return body;
}

/**
 * A person's image without what describes it, for a JPEG, PNG or WebP; any
 * other bytes, and an image whose structure is not understood, as they came.
 */
export function withoutImageMetadata(bytes: Uint8Array): Uint8Array {
  const start = ascii(bytes, 0, 4);
  const stripped =
    bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      ? jpeg(bytes)
      : start === "\x89PNG"
        ? png(bytes)
        : start === "RIFF" && ascii(bytes, 8, 4) === "WEBP"
          ? webp(bytes)
          : null;
  return stripped ?? bytes;
}
