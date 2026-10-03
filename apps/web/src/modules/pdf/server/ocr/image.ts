// Loaded by the PDF worker under plain Node in development: relative imports only.
import type { Quad } from "./geometry.ts";

/** Packed RGB, three bytes a pixel, rows top to bottom. */
export interface RgbImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** RGB from a canvas's RGBA pixels; alpha is dropped over white, as paper is. */
export function fromRgba(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const alpha = rgba[i + 3]! / 255;
    const over = 255 * (1 - alpha);
    data[j] = rgba[i]! * alpha + over;
    data[j + 1] = rgba[i + 1]! * alpha + over;
    data[j + 2] = rgba[i + 2]! * alpha + over;
  }
  return { data, width, height };
}

/** One channel sampled bilinearly at (x, y), edges repeated. */
const sample = (image: RgbImage, x: number, y: number, channel: number) => {
  const cx = Math.min(Math.max(x, 0), image.width - 1);
  const cy = Math.min(Math.max(y, 0), image.height - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, image.width - 1);
  const y1 = Math.min(y0 + 1, image.height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const at = (px: number, py: number) => image.data[(py * image.width + px) * 3 + channel]!;
  const top = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
  const bottom = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
  return top * (1 - fy) + bottom * fy;
};

/** Bilinear resize with pixel centres aligned, as OpenCV's default does. */
export function resize(image: RgbImage, width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3);
  const sx = image.width / width;
  const sy = image.height / height;
  for (let y = 0; y < height; y++) {
    const srcY = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < width; x++) {
      const srcX = (x + 0.5) * sx - 0.5;
      const out = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) data[out + c] = Math.round(sample(image, srcX, srcY, c));
    }
  }
  return { data, width, height };
}

/**
 * The text line inside `quad`, straightened onto a rectangle; a crop much
 * taller than wide is turned a quarter, as vertical text is read sideways.
 */
const dist = (a: readonly [number, number], b: readonly [number, number]) =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);

export function cropQuad(image: RgbImage, quad: Quad): RgbImage {
  const width = Math.max(1, Math.trunc(Math.max(dist(quad[0], quad[1]), dist(quad[2], quad[3]))));
  const height = Math.max(1, Math.trunc(Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]))));
  const data = new Uint8Array(width * height * 3);
  const [p0, p1, p2, p3] = quad;
  for (let y = 0; y < height; y++) {
    const t = height === 1 ? 0 : y / height;
    for (let x = 0; x < width; x++) {
      const s = width === 1 ? 0 : x / width;
      const srcX =
        (1 - s) * (1 - t) * p0[0] + s * (1 - t) * p1[0] + s * t * p2[0] + (1 - s) * t * p3[0];
      const srcY =
        (1 - s) * (1 - t) * p0[1] + s * (1 - t) * p1[1] + s * t * p2[1] + (1 - s) * t * p3[1];
      const out = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) data[out + c] = Math.round(sample(image, srcX, srcY, c));
    }
  }
  const crop = { data, width, height };
  return height / width >= 1.5 ? rotateCounterClockwise(crop) : crop;
}

function rotateCounterClockwise(image: RgbImage): RgbImage {
  const width = image.height;
  const height = image.width;
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (x * image.width + (image.width - 1 - y)) * 3;
      const to = (y * width + x) * 3;
      data[to] = image.data[from]!;
      data[to + 1] = image.data[from + 1]!;
      data[to + 2] = image.data[from + 2]!;
    }
  return { data, width, height };
}

/**
 * The image as a planar BGR tensor scaled to [-1, 1], written into `into` at
 * `offset` with `rowWidth` columns per plane: the models were trained on
 * OpenCV's channel order, and recognition pads lines to the batch's width.
 */
export function writeTensor(
  image: RgbImage,
  into: Float32Array,
  offset = 0,
  rowWidth = image.width,
) {
  const plane = image.height * rowWidth;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + x) * 3;
      const to = offset + y * rowWidth + x;
      into[to] = image.data[from + 2]! / 127.5 - 1;
      into[to + plane] = image.data[from + 1]! / 127.5 - 1;
      into[to + 2 * plane] = image.data[from]! / 127.5 - 1;
    }
}
