export type PageKind = "text" | "scan" | "blank";

/** Removes NUL and other C0/DEL controls, keeping tab, newline and carriage return. */
export const stripControlCharacters = (text: string): string =>
  // eslint-disable-next-line no-control-regex -- the whole point is the control range
  text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

/**
 * What a page is, from three measurements: characters in its text layer
 * (whitespace excluded), the share of the page images cover, and, only when
 * both are near zero, the share of dark pixels in a small render.
 *
 * A heuristic with known bounds: a page mostly covered by images with a thin
 * text layer is a scan, even under a scanner's stamp; a page with real text is
 * text, so content in images or shapes beside that text is not read; a page
 * with neither is a scan when it shows much ink, since it is then drawn text.
 */
export function classifyPage(input: {
  chars: number;
  coverage: number;
  ink: number | null;
}): PageKind | "needs-ink" {
  if (input.coverage >= 0.5 && input.chars < 100) return "scan";
  // Any text layer is kept, however short: a large "PAID" is text, not a scan.
  if (input.chars > 0) return "text";
  if (input.ink === null) return "needs-ink";
  // No text layer: much ink is content drawn as shapes, read like a scan.
  return input.ink < 0.002 ? "blank" : "scan";
}

type Matrix = readonly [number, number, number, number, number, number];
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Six finite numbers as a matrix, or null: operator arguments are the PDF's, not ours. */
const asMatrix = (value: unknown): Matrix | null => {
  if (!Array.isArray(value) || value.length !== 6) return null;
  const [a, b, c, d, e, f] = value.map(Number);
  return [a!, b!, c!, d!, e!, f!].every(Number.isFinite) ? [a!, b!, c!, d!, e!, f!] : null;
};

/** The operator codes coverage needs, taken from pdf.js's `OPS` so they never drift. */
export interface CoverageOps {
  readonly save: number;
  readonly restore: number;
  readonly transform: number;
  readonly formBegin: number;
  readonly formEnd: number;
  readonly images: ReadonlySet<number>;
}

/**
 * The share of the page box images are painted over. Each image fills the
 * unit square under the current transform; its bounding box is clipped to the
 * page, and overlapping images are summed, capped at the whole page.
 */
export function imageCoverage(
  view: readonly [number, number, number, number],
  operators: { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> },
  ops: CoverageOps,
) {
  const [x0, y0, x1, y1] = view;
  const area = Math.abs((x1 - x0) * (y1 - y0));
  if (area === 0) return 0;
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  let covered = 0;
  for (let i = 0; i < operators.fnArray.length; i++) {
    const op = operators.fnArray[i]!;
    const args = operators.argsArray[i];
    if (op === ops.save) stack.push(ctm);
    else if (op === ops.restore) ctm = stack.pop() ?? ctm;
    else if (op === ops.transform) {
      const matrix = asMatrix(args);
      if (matrix) ctm = multiply(ctm, matrix);
    } else if (op === ops.formBegin) {
      // A form XObject draws in its own space; its matrix applies until it ends.
      stack.push(ctm);
      const matrix = asMatrix(Array.isArray(args) ? args[0] : null);
      if (matrix) ctm = multiply(ctm, matrix);
    } else if (op === ops.formEnd) ctm = stack.pop() ?? ctm;
    else if (ops.images.has(op)) {
      const corners = [
        [ctm[4], ctm[5]],
        [ctm[0] + ctm[4], ctm[1] + ctm[5]],
        [ctm[2] + ctm[4], ctm[3] + ctm[5]],
        [ctm[0] + ctm[2] + ctm[4], ctm[1] + ctm[3] + ctm[5]],
      ];
      const left = Math.max(Math.min(...corners.map((c) => c[0]!)), Math.min(x0, x1));
      const right = Math.min(Math.max(...corners.map((c) => c[0]!)), Math.max(x0, x1));
      const bottom = Math.max(Math.min(...corners.map((c) => c[1]!)), Math.min(y0, y1));
      const top = Math.min(Math.max(...corners.map((c) => c[1]!)), Math.max(y0, y1));
      if (right > left && top > bottom) covered += (right - left) * (top - bottom);
    }
  }
  return Math.min(1, covered / area);
}

/**
 * The share of pixels clearly darker than the page's own paper colour, so a
 * grey scan or a photographed page still reads as blank when nothing is on it.
 */
export function inkShare(rgba: ArrayLike<number>) {
  const histogram = new Uint32Array(256);
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  const grey = new Uint8Array(pixels);
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    const alpha = rgba[i + 3]! / 255;
    const value = Math.round(
      (0.299 * rgba[i]! + 0.587 * rgba[i + 1]! + 0.114 * rgba[i + 2]!) * alpha + 255 * (1 - alpha),
    );
    grey[p] = value;
    histogram[value]!++;
  }
  // Paper is the 60th percentile: most of a page is background.
  let seen = 0;
  let paper = 255;
  for (let v = 0; v < 256; v++) {
    seen += histogram[v]!;
    if (seen > pixels * 0.6) {
      paper = v;
      break;
    }
  }
  let dark = 0;
  for (let p = 0; p < pixels; p++) if (grey[p]! < paper - 60) dark++;
  return dark / pixels;
}
