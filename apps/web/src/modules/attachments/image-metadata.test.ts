import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readImageSize } from "./image-header.ts";
import { withoutImageMetadata } from "./image-metadata.ts";

const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const has = (bytes: Uint8Array, s: string) => Buffer.from(bytes).includes(s);

// Big-endian TIFF with the orientation and one more entry standing in for GPS.
const tiff = (orientation: number) => [
  ...text("MM"),
  ...be16(42),
  ...be32(8),
  ...be16(2),
  0x01,
  0x12,
  0,
  3,
  ...be32(1),
  ...be16(orientation),
  0,
  0,
  0x88,
  0x25,
  0,
  4,
  ...be32(1),
  ...be32(0),
  ...be32(0),
  ...text("GPS 52.52N"),
];
const segment = (marker: number, body: number[]) => [
  0xff,
  marker,
  ...be16(body.length + 2),
  ...body,
];

const jpeg = (orientation: number) =>
  Uint8Array.from([
    0xff,
    0xd8,
    ...segment(0xe0, text("JFIF\0")),
    ...segment(0xe1, [...text("Exif\0\0"), ...tiff(orientation)]),
    ...segment(0xe1, text("http://ns.adobe.com/xap/1.0/\0taken at home")),
    ...segment(0xe2, text("ICC_PROFILE\0colour")),
    ...segment(0xed, text("Photoshop 3.0\0byline")),
    ...segment(0xfe, text("a comment")),
    ...segment(0xdb, [0, 1, 2]),
    ...segment(0xc0, [8, ...be16(30), ...be16(40), 3]),
    ...segment(0xda, [1, 2]),
    // Entropy-coded data with a stuffed FF and a restart marker inside.
    0x12,
    0xff,
    0x00,
    0x34,
    0xff,
    0xd0,
    0x56,
    0xff,
    0xd9,
    ...text("motion photo trailer"),
  ]);

const chunk = (type: string, body: number[]) => [
  ...be32(body.length),
  ...text(type),
  ...body,
  0,
  0,
  0,
  0,
];
const png = (orientation: number) =>
  Uint8Array.from([
    0x89,
    ...text("PNG\r\n\x1a\n"),
    ...chunk("IHDR", [...be32(40), ...be32(30), 8, 6, 0, 0, 0]),
    ...chunk("tEXt", text("Location\0home")),
    ...chunk("iCCP", text("profile")),
    ...chunk("eXIf", tiff(orientation)),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);

const riffChunk = (type: string, body: number[]) => [
  ...text(type),
  ...le32(body.length),
  ...body,
  ...(body.length % 2 ? [0] : []),
];
const webp = (orientation: number) => {
  const body = [
    ...text("WEBP"),
    ...riffChunk("VP8X", [0x2c, 0, 0, 0, 39, 0, 0, 29, 0, 0]),
    ...riffChunk("ICCP", text("profile")),
    ...riffChunk("VP8 ", [1, 2, 3]),
    ...riffChunk("EXIF", tiff(orientation)),
    ...riffChunk("XMP ", text("taken at home")),
  ];
  return Uint8Array.from([...text("RIFF"), ...le32(body.length), ...body]);
};

describe("withoutImageMetadata", () => {
  it("keeps what draws a JPEG and drops what describes it, past its end too", () => {
    const stripped = withoutImageMetadata(jpeg(1));
    for (const gone of ["Exif", "GPS", "taken at home", "byline", "a comment", "trailer"])
      expect(has(stripped, gone)).toBe(false);
    for (const kept of ["JFIF", "ICC_PROFILE"]) expect(has(stripped, kept)).toBe(true);
    expect(
      Buffer.from(stripped).includes(Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56])),
    ).toBe(true);
    expect(readImageSize(stripped, "image/jpeg")).toEqual({ width: 40, height: 30 });
  });

  it("keeps a turned photo's orientation alone, right after JFIF", () => {
    const stripped = withoutImageMetadata(jpeg(6));
    expect(has(stripped, "GPS")).toBe(false);
    expect(Buffer.from(stripped).indexOf("Exif")).toBe(2 + 9 + 4);
    expect(readImageSize(stripped, "image/jpeg")).toEqual({ width: 30, height: 40 });
  });

  it("keeps a PNG's drawing chunks and rebuilds a turned one's eXIf with a valid checksum", () => {
    expect(has(withoutImageMetadata(png(1)), "eXIf")).toBe(false);
    const stripped = withoutImageMetadata(png(6));
    expect(has(stripped, "Location")).toBe(false);
    expect(has(stripped, "GPS")).toBe(false);
    expect(has(stripped, "iCCP")).toBe(true);
    const at = Buffer.from(stripped).indexOf("eXIf") - 4;
    const length = Buffer.from(stripped).readUInt32BE(at);
    expect(Buffer.from(stripped).readUInt32BE(at + 8 + length)).toBe(
      crc32(stripped.subarray(at + 4, at + 8 + length)),
    );
  });

  it("drops a WebP's EXIF and XMP and fixes the header to match", () => {
    const stripped = withoutImageMetadata(webp(1));
    expect(has(stripped, "EXIF")).toBe(false);
    expect(has(stripped, "XMP ")).toBe(false);
    expect(has(stripped, "ICCP")).toBe(true);
    expect(stripped[20]).toBe(0x20);
    expect(Buffer.from(stripped).readUInt32LE(4)).toBe(stripped.length - 8);
  });

  it("keeps a turned WebP's orientation alone, and the header's promise of it", () => {
    const stripped = withoutImageMetadata(webp(6));
    expect(has(stripped, "GPS")).toBe(false);
    expect(has(stripped, "EXIF")).toBe(true);
    expect(stripped[20]).toBe(0x28);
    expect(Buffer.from(stripped).readUInt32LE(4)).toBe(stripped.length - 8);
  });

  it("returns anything else, or an image it cannot follow, as it came", () => {
    const pdf = Uint8Array.from(text("%PDF-1.7 GPS"));
    expect(withoutImageMetadata(pdf)).toBe(pdf);
    const cut = jpeg(6).subarray(0, 40);
    expect(withoutImageMetadata(cut)).toBe(cut);
  });
});
