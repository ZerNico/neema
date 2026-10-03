import { describe, expect, it } from "vitest";
import { joinLines } from "./engine.ts";
import {
  boxScore,
  minAreaRect,
  miniBox,
  readingOrder,
  regions,
  unclip,
  type Quad,
} from "./geometry.ts";

const rect = (x: number, y: number, w: number, h: number): Quad => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

describe("detection geometry", () => {
  it("finds each connected region of a mask", () => {
    const width = 10;
    const mask = new Uint8Array(width * 4);
    for (const x of [1, 2, 3]) mask[width + x] = 1;
    for (const x of [6, 7]) mask[2 * width + x] = 1;
    expect(regions(mask, width, 4, 10)).toHaveLength(2);
  });

  it("fits the smallest rectangle around a rotated line", () => {
    const points = Array.from({ length: 20 }, (_, i): [number, number] => [i, i]);
    const { width, height } = minAreaRect(points);
    expect(Math.max(width, height)).toBeCloseTo(Math.hypot(19, 19));
    expect(Math.min(width, height)).toBeCloseTo(0);
  });

  it("orders a box's corners and reports its shorter side", () => {
    const { box, shortSide } = miniBox(rect(10, 20, 100, 30));
    expect(box[0]).toEqual([10, 20]);
    expect(box[2]).toEqual([110, 50]);
    expect(shortSide).toBeCloseTo(30);
  });

  it("grows a box by area times ratio over perimeter on every side", () => {
    const grown = unclip(rect(0, 0, 100, 20), 1.6);
    const distance = (100 * 20 * 1.6) / 240;
    expect(grown[0][0]).toBeCloseTo(-distance);
    expect(grown[2][1]).toBeCloseTo(20 + distance);
  });

  it("scores a box by the mean of the map inside it", () => {
    const map = new Float32Array(16).fill(0);
    map[5] = 1;
    map[6] = 1;
    expect(boxScore(map, 4, 4, rect(1, 1, 1, 0))).toBeCloseTo(1);
  });
});

describe("reading order", () => {
  it("reads rows top to bottom and each row left to right", () => {
    const ordered = readingOrder([
      { box: rect(300, 104, 50, 20), text: "right" },
      { box: rect(10, 100, 50, 20), text: "left" },
      { box: rect(10, 200, 50, 20), text: "below" },
    ]);
    expect(ordered.map((item) => item.text)).toEqual(["left", "right", "below"]);
  });

  it("joins boxes on one visual line with spaces, lines with newlines", () => {
    expect(
      joinLines([
        { box: rect(10, 100, 80, 20), text: "Total" },
        { box: rect(300, 103, 60, 20), text: "42,00 €" },
        { box: rect(10, 140, 80, 20), text: "Danke" },
      ]),
    ).toBe("Total 42,00 €\nDanke");
  });
});
