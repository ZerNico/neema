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

/** The EXIF orientation (1 to 8) in the TIFF data from `tiff` to `end`, or null. */
function tiffOrientation(b: Uint8Array, tiff: number, end: number): number | null {
  if (tiff + 8 > end) return null;
  const little = b[tiff] === 0x49;
  const u16 = (i: number) => (little ? u16le(b, i) : u16be(b, i));
  const u32 = (i: number) => (little ? u16le(b, i) + u16le(b, i + 2) * 65536 : u32be(b, i));
  const ifd = tiff + u32(tiff + 4);
  if (u16(tiff + 2) !== 42 || ifd + 2 > end) return null;
  for (let entry = ifd + 2, n = u16(ifd); n > 0 && entry + 12 <= end; n--, entry += 12)
    if (u16(entry) === 0x0112) return u16(entry + 8);
  return null;
}

/** The orientation an APP1 segment from `at` to `end` carries, when it is EXIF. */
function exifOrientation(b: Uint8Array, at: number, end: number) {
  if (at + 10 > end || String.fromCharCode(...b.subarray(at + 4, at + 10)) !== "Exif\0\0")
    return null;
  return tiffOrientation(b, at + 10, end);
}

function jpeg(b: Uint8Array, oriented: boolean): ImageSize | null {
  let turned = false;
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
      const [width, height] = [u16be(b, at + 7), u16be(b, at + 5)];
      return turned ? { width: height, height: width } : { width, height };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    // Orientations 5 to 8 turn the picture a quarter, so a browser shows it
    // with its stored sides swapped.
    if (oriented && marker === 0xe1 && !turned) {
      const orientation = exifOrientation(b, at, Math.min(at + 2 + length, b.length));
      turned = orientation !== null && orientation >= 5 && orientation <= 8;
    }
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

/**
 * Width and height from the header of an already sniffed image, or null when
 * unreadable. `oriented` gives the size a browser shows, after a JPEG's EXIF
 * rotation; Office files and canvases lay out the stored pixels.
 */
function headerSize(bytes: Uint8Array, mediaType: string, oriented: boolean): ImageSize | null {
  const size =
    mediaType === "image/png"
      ? png(bytes)
      : mediaType === "image/gif"
        ? gif(bytes)
        : mediaType === "image/jpeg"
          ? jpeg(bytes, oriented)
          : mediaType === "image/webp"
            ? webp(bytes)
            : null;
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** The size a browser shows an already sniffed image at, or null when unreadable. */
export const readImageSize = (bytes: Uint8Array, mediaType: string) =>
  headerSize(bytes, mediaType, true);

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
  const size = mediaType ? headerSize(bytes, mediaType, false) : null;
  return mediaType && size ? { mediaType, ...size } : null;
}
