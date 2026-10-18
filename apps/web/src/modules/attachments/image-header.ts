// Worker processes load this file under plain Node: no imports, no `~` alias.
// Image type and dimensions from the header bytes alone, so untrusted image
// data is judged without a decoder: enough to refuse a decompression bomb
// before a reader's browser is handed it.

export const IMAGE_SIZE_LIMITS = {
  side: 6000,
  pixels: 25_000_000,
} as const;

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + ((b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!);

function png(b: Uint8Array): ImageSize | null {
  // Signature, then the IHDR chunk: length, type, width, height.
  if (b.length < 24 || String.fromCharCode(...b.subarray(12, 16)) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  return { width: u16le(b, 6), height: u16le(b, 8) };
}

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1]!;
    // Fill bytes before a marker.
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    // Start of frame: every SOFn except DHT (c4), JPG (c8) and DAC (cc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (at + 9 > b.length) return null;
      return { width: u16be(b, at + 7), height: u16be(b, at + 5) };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    at += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const chunk = String.fromCharCode(...b.subarray(12, 16));
  if (chunk === "VP8 ") {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit sizes.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** Width and height from the header of an already sniffed image, or null when unreadable. */
export function readImageSize(bytes: Uint8Array, mediaType: string): ImageSize | null {
  const size =
    mediaType === "image/png"
      ? png(bytes)
      : mediaType === "image/gif"
        ? gif(bytes)
        : mediaType === "image/jpeg"
          ? jpeg(bytes)
          : mediaType === "image/webp"
            ? webp(bytes)
            : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** True when the browser may be handed the image: readable and within the limits. */
export function acceptableImageSize(size: ImageSize | null): size is ImageSize {
  return (
    size !== null &&
    size.width <= IMAGE_SIZE_LIMITS.side &&
    size.height <= IMAGE_SIZE_LIMITS.side &&
    size.width * size.height <= IMAGE_SIZE_LIMITS.pixels
  );
}

/** The type a file's own first bytes say it is, of the four a browser draws. */
function sniff(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && String.fromCharCode(...b.subarray(1, 4)) === "PNG")
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...b.subarray(0, 6))))
    return "image/gif";
  if (
    b.length >= 12 &&
    String.fromCharCode(...b.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  return null;
}

/** Type and size as the bytes themselves give them, or null for anything else or unreadable. */
export function imageHeader(bytes: Uint8Array): (ImageSize & { mediaType: string }) | null {
  const mediaType = sniff(bytes);
  const size = mediaType ? readImageSize(bytes, mediaType) : null;
  return mediaType && size ? { mediaType, ...size } : null;
}
