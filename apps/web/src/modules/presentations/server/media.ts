import { PRESENTATION_LIMITS } from "../limits.ts";
import { fail } from "./package-xml.ts";

/**
 * Two questions about pictures, answered differently. A picture an edit adds
 * must be a PNG or JPEG the preview can draw. A picture a deck already has is
 * kept byte for byte whatever it is; only whether the preview may decode it
 * depends on these checks.
 */
export type Raster = {
  readonly format: "png" | "jpg";
  readonly width: number;
  readonly height: number;
};

const PNG = [137, 80, 78, 71, 13, 10, 26, 10];
const startOfFrame = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export const isPng = (data: Uint8Array) =>
  data.length >= 8 && PNG.every((byte, index) => data[index] === byte);

/** Format and pixel size read from the header, or null for anything else or anything malformed. */
export function rasterInfo(data: Uint8Array): Raster | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (isPng(data)) {
    if (data.length < 24 || view.getUint32(8) !== 13) return null;
    if (String.fromCharCode(...data.subarray(12, 16)) !== "IHDR") return null;
    return { format: "png", width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;
  // Segments up to the first frame header; bytes after the image, such as an
  // appended thumbnail or padding, are not ours to judge.
  for (let at = 2; at + 4 < data.length;) {
    if (data[at] !== 0xff) return null;
    while (data[at] === 0xff) at++;
    const marker = data[at++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > data.length) return null;
    const length = view.getUint16(at);
    if (length < 2 || at + length > data.length) return null;
    if (startOfFrame.has(marker))
      return length < 7
        ? null
        : { format: "jpg", width: view.getUint16(at + 5), height: view.getUint16(at + 3) };
    at += length;
  }
  return null;
}

const withinBounds = (raster: Raster) =>
  raster.width > 0 &&
  raster.height > 0 &&
  raster.width <= PRESENTATION_LIMITS.imageSide &&
  raster.height <= PRESENTATION_LIMITS.imageSide &&
  raster.width * raster.height <= PRESENTATION_LIMITS.imagePixels;

/** A bitmap the preview may decode: a PNG or JPEG within the byte and pixel bounds. */
export function drawableRaster(data: Uint8Array) {
  if (data.length > PRESENTATION_LIMITS.imageBytes) return null;
  const raster = rasterInfo(data);
  return raster && withinBounds(raster) ? raster : null;
}

/** The format of a picture an edit adds, which must be one every preview can draw. */
export function addedImageFormat(image: Uint8Array): "png" | "jpg" {
  if (image.length > PRESENTATION_LIMITS.imageBytes)
    return fail("limit", "Image exceeds the byte limit.");
  const raster = rasterInfo(image);
  if (!raster) return fail("invalid_operation", "Only PNG and JPEG images are supported.");
  if (!withinBounds(raster))
    return fail(
      "limit",
      `Image dimensions exceed ${PRESENTATION_LIMITS.imageSide} pixels a side or ${PRESENTATION_LIMITS.imagePixels / 1_000_000} megapixels.`,
    );
  return raster.format;
}
