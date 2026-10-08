import { describe, expect, it } from "vitest";
import { acceptableImageSize, readImageSize } from "./image-header.ts";

const bytes = (...parts: Array<number[] | string>) =>
  Uint8Array.from(
    parts.flatMap((part) =>
      typeof part === "string" ? [...part].map((c) => c.charCodeAt(0)) : part,
    ),
  );
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

const png = (w: number, h: number) =>
  bytes(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    be32(13),
    "IHDR",
    be32(w),
    be32(h),
    [8, 6, 0, 0, 0],
  );
const gif = (w: number, h: number) => bytes("GIF89a", le16(w), le16(h), [0, 0, 0]);
const jpeg = (w: number, h: number) =>
  bytes(
    [0xff, 0xd8],
    // An APP0 segment to skip, then a baseline frame header.
    [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00],
    [0xff, 0xc0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255, 0x03],
  );
const riff = (chunk: string, body: number[]) =>
  bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk, [0, 0, 0, 0], body, Array.from({ length: 16 }, () => 0));
const vp8x = (w: number, h: number) => riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);
const vp8 = (w: number, h: number) =>
  riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const vp8l = (w: number, h: number) => {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff("VP8L", [
    0x2f,
    bits & 255,
    (bits >>> 8) & 255,
    (bits >>> 16) & 255,
    (bits >>> 24) & 255,
  ]);
};

describe("readImageSize", () => {
  it.each([
    ["image/png", png(640, 480)],
    ["image/gif", gif(640, 480)],
    ["image/jpeg", jpeg(640, 480)],
    ["image/webp", vp8x(640, 480)],
    ["image/webp", vp8(640, 480)],
    ["image/webp", vp8l(640, 480)],
  ])("reads %s dimensions from the header", (mediaType, data) => {
    expect(readImageSize(data, mediaType)).toEqual({ width: 640, height: 480 });
  });

  it("refuses truncated or malformed headers", () => {
    expect(readImageSize(png(1, 1).subarray(0, 20), "image/png")).toBeNull();
    expect(readImageSize(bytes([0xff, 0xd8, 0x00, 0x00]), "image/jpeg")).toBeNull();
    expect(readImageSize(jpeg(0, 10), "image/jpeg")).toBeNull();
    expect(readImageSize(riff("ABCD", []), "image/webp")).toBeNull();
    expect(readImageSize(png(10, 10), "image/svg+xml")).toBeNull();
  });

  it("accepts only sizes a browser should be asked to decode", () => {
    expect(acceptableImageSize(readImageSize(png(6000, 4000), "image/png"))).toBe(true);
    expect(acceptableImageSize(readImageSize(png(6001, 10), "image/png"))).toBe(false);
    expect(acceptableImageSize(readImageSize(png(5000, 5001), "image/png"))).toBe(false);
    expect(acceptableImageSize(readImageSize(gif(65535, 65535), "image/gif"))).toBe(false);
    expect(acceptableImageSize(null)).toBe(false);
  });
});
