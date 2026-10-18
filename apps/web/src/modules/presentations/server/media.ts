import { PRESENTATION_LIMITS } from "../limits.ts";
import { imageHeader } from "../../attachments/image-header.ts";
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

/** Format and pixel size read from the header, or null for anything else or anything malformed. */
export function rasterInfo(data: Uint8Array): Raster | null {
  const header = imageHeader(data);
  const format =
    header?.mediaType === "image/png" ? "png" : header?.mediaType === "image/jpeg" ? "jpg" : null;
  return header && format ? { format, width: header.width, height: header.height } : null;
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
