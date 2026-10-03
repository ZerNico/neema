// Loaded by the PDF worker under plain Node in development: relative imports only.

/** A point as [x, y]. */
export type Point = readonly [number, number];
/** Four corners: top-left, top-right, bottom-right, bottom-left once ordered. */
export type Quad = readonly [Point, Point, Point, Point];

/**
 * The connected regions (8-neighbour) of a binary mask, each as its edge
 * pixels: enough for a hull, at a fraction of the points. This stands in for
 * OpenCV's contour search, which the detector's post-processing was written against.
 */
export function regions(mask: Uint8Array, width: number, height: number, limit: number) {
  const seen = new Uint8Array(mask.length);
  const found: Point[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length && found.length < limit; start++) {
    if (!mask[start] || seen[start]) continue;
    const edge: Point[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop()!;
      const x = index % width;
      const y = (index - x) / width;
      let border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const next = ny * width + nx;
          if (!mask[next]) {
            if (dx === 0 || dy === 0) border = true;
            continue;
          }
          if (seen[next]) continue;
          seen[next] = 1;
          stack.push(next);
        }
      }
      if (border) edge.push([x, y]);
    }
    found.push(edge);
  }
  return found;
}

const cross = (o: Point, a: Point, b: Point) =>
  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull, counter-clockwise, by the monotone chain. */
export function convexHull(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (const point of sorted.toReversed()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The smallest rotated rectangle around the points (rotating calipers over the hull). */
export function minAreaRect(points: readonly Point[]): {
  corners: Point[];
  width: number;
  height: number;
} {
  const hull = convexHull(points);
  if (hull.length === 0) return { corners: [], width: 0, height: 0 };
  if (hull.length === 1)
    return { corners: [hull[0]!, hull[0]!, hull[0]!, hull[0]!], width: 0, height: 0 };
  let best: { corners: Point[]; width: number; height: number; area: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length === 0) continue;
    const ux = (b[0] - a[0]) / length;
    const uy = (b[1] - a[1]) / length;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p[0] * ux + p[1] * uy;
      const v = -p[0] * uy + p[1] * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (best && area >= best.area) continue;
    const at = (u: number, v: number): Point => [u * ux - v * uy, u * uy + v * ux];
    best = {
      corners: [at(minU, minV), at(maxU, minV), at(maxU, maxV), at(minU, maxV)],
      width: maxU - minU,
      height: maxV - minV,
      area,
    };
  }
  return best ?? { corners: [hull[0]!, hull[0]!, hull[0]!, hull[0]!], width: 0, height: 0 };
}

/**
 * A rectangle's corners in the detector's order, with its shorter side: the
 * order the reference implementation derives from points sorted by x.
 */
export function miniBox(points: readonly Point[]): { box: Quad; shortSide: number } {
  const rect = minAreaRect(points);
  const sorted = rect.corners.toSorted((a, b) => a[0] - b[0]);
  const [p0, p1, p2, p3] = sorted as [Point, Point, Point, Point];
  const [first, fourth] = p1[1] > p0[1] ? [p0, p1] : [p1, p0];
  const [second, third] = p3[1] > p2[1] ? [p2, p3] : [p3, p2];
  return { box: [first, second, third, fourth], shortSide: Math.min(rect.width, rect.height) };
}

/**
 * The box grown by `area * ratio / perimeter` on every side. The reference
 * offsets the polygon with rounded joins and takes the minimum rectangle
 * again; for a rectangle that is exactly this.
 */
export function unclip(box: Quad, ratio: number): Quad {
  const width = Math.hypot(box[1][0] - box[0][0], box[1][1] - box[0][1]);
  const height = Math.hypot(box[3][0] - box[0][0], box[3][1] - box[0][1]);
  if (width === 0 || height === 0) return box;
  const distance = (width * height * ratio) / (2 * (width + height));
  const ux = (box[1][0] - box[0][0]) / width;
  const uy = (box[1][1] - box[0][1]) / width;
  const vx = (box[3][0] - box[0][0]) / height;
  const vy = (box[3][1] - box[0][1]) / height;
  const move = (p: Point, su: number, sv: number): Point => [
    p[0] + distance * (su * ux + sv * vx),
    p[1] + distance * (su * uy + sv * vy),
  ];
  return [move(box[0], -1, -1), move(box[1], 1, -1), move(box[2], 1, 1), move(box[3], -1, 1)];
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** Mean of `map` inside the quadrilateral, over its bounding box clipped to the map. */
export function boxScore(map: Float32Array, width: number, height: number, box: Quad) {
  const xs = box.map((p) => p[0]);
  const ys = box.map((p) => p[1]);
  const xmin = clamp(Math.floor(Math.min(...xs)), width - 1);
  const xmax = clamp(Math.ceil(Math.max(...xs)), width - 1);
  const ymin = clamp(Math.floor(Math.min(...ys)), height - 1);
  const ymax = clamp(Math.ceil(Math.max(...ys)), height - 1);
  const corners = box.map((p) => [Math.trunc(p[0]), Math.trunc(p[1])] as const);
  let sum = 0;
  let count = 0;
  for (let y = ymin; y <= ymax; y++)
    for (let x = xmin; x <= xmax; x++) {
      if (!insideQuad(corners, x, y)) continue;
      sum += map[y * width + x]!;
      count++;
    }
  return count === 0 ? 0 : sum / count;
}

/** Inside or on the edge of a convex quadrilateral, whichever way it winds. */
function insideQuad(quad: ReadonlyArray<readonly [number, number]>, x: number, y: number) {
  let positive = false;
  let negative = false;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const side = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (side > 0) positive = true;
    else if (side < 0) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

/** Top-left, top-right, bottom-right, bottom-left. */
export function orderClockwise(points: Quad): Quad {
  const byX = points.toSorted((a, b) => a[0] - b[0]);
  const [tl, bl] = byX.slice(0, 2).toSorted((a, b) => a[1] - b[1]) as [Point, Point];
  const [tr, br] = byX.slice(2).toSorted((a, b) => a[1] - b[1]) as [Point, Point];
  return [tl, tr, br, bl];
}

/** Boxes in reading order: rows top to bottom (a 10 px step starts a new row), then left to right. */
export function readingOrder<T extends { box: Quad }>(items: readonly T[]): T[] {
  const byY = items
    .map((item, index) => ({ item, index }))
    .toSorted((a, b) => a.item.box[0][1] - b.item.box[0][1] || a.index - b.index);
  let row = 0;
  const rows = byY.map((entry, i) => {
    if (i > 0 && entry.item.box[0][1] - byY[i - 1]!.item.box[0][1] >= 10) row++;
    return { ...entry, row };
  });
  return rows
    .toSorted((a, b) => a.row - b.row || a.item.box[0][0] - b.item.box[0][0])
    .map((entry) => entry.item);
}
