/**
 * Image bytes in and out: base64 both ways, the type a file really is, and its
 * dimensions. Providers' claims about media types are checked, never trusted.
 */

import { Effect } from "effect";
import { invalidOutput } from "../errors.ts";
import type { ReferenceType } from "./families.ts";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Base64 of the largest accepted image, padding included. */
export const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;

const startsWith = (bytes: Uint8Array, signature: ReadonlyArray<number>, offset = 0) =>
  bytes.length >= offset + signature.length &&
  signature.every((byte, index) => bytes[offset + index] === byte);

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

/** PNG, JPEG or WebP by signature; null for anything else, GIF included. */
export const sniffImage = (bytes: Uint8Array): ReferenceType | null => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
};

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

const jpegSize = (bytes: Uint8Array) => {
  const data = view(bytes);
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    const length = data.getUint16(offset + 2);
    // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) };
    offset += 2 + length;
  }
  return null;
};

const webpSize = (bytes: Uint8Array) => {
  if (bytes.length < 31) return null;
  const data = view(bytes);
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === "VP8X")
    return {
      width: 1 + (data.getUint32(24, true) & 0xffffff),
      height: 1 + (data.getUint32(27, true) & 0xffffff),
    };
  if (chunk === "VP8L") {
    const bits = data.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (chunk === "VP8 ")
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
  return null;
};

/** Pixel dimensions from the header, or null when the header cannot be read. */
export const imageSize = (bytes: Uint8Array): { width: number; height: number } | null => {
  switch (sniffImage(bytes)) {
    case "image/png":
      return bytes.length >= 24
        ? { width: view(bytes).getUint32(16), height: view(bytes).getUint32(20) }
        : null;
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return null;
  }
};

export const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const dataUri = (reference: { readonly mediaType: string; readonly bytes: Uint8Array }) =>
  `data:${reference.mediaType};base64,${toBase64(reference.bytes)}`;

const DATA_URI = /^data:([^;,]+)?(?:;[^,]*)?;base64,/i;

/**
 * One returned image: bare base64 or a data URI, capped before decoding and
 * sniffed after. A declared type that disagrees with the bytes is an error.
 */
export const decodeImage = (encoded: string, declared?: string | null) =>
  Effect.gen(function* () {
    const prefix = DATA_URI.exec(encoded);
    const claimed = (prefix?.[1] ?? declared ?? undefined)?.toLowerCase();
    const body = (prefix ? encoded.slice(prefix[0].length) : encoded).replace(/\s+/g, "");
    if (body.length > MAX_BASE64_LENGTH)
      return yield* Effect.fail(invalidOutput("The provider returned an image larger than 20 MB"));
    if (body.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body))
      return yield* Effect.fail(invalidOutput("The provider returned an image that is not base64"));
    const data = new Uint8Array(Buffer.from(body, "base64"));
    if (data.byteLength > MAX_IMAGE_BYTES)
      return yield* Effect.fail(invalidOutput("The provider returned an image larger than 20 MB"));
    const mediaType = sniffImage(data);
    if (!mediaType)
      return yield* Effect.fail(
        invalidOutput("The provider returned a file that is not a PNG, JPEG or WebP image"),
      );
    const normalizedClaim = claimed === "image/jpg" ? "image/jpeg" : claimed;
    if (normalizedClaim && normalizedClaim !== mediaType)
      return yield* Effect.fail(
        invalidOutput(`The provider labelled a ${mediaType} image as ${normalizedClaim}`),
      );
    return { mediaType, data };
  });
