import { describe, expect, it } from "vitest";
import { classifyPage, imageCoverage, inkShare, stripControlCharacters } from "./classify.ts";

const OPS = {
  save: 1,
  restore: 2,
  transform: 3,
  formBegin: 4,
  formEnd: 5,
  images: new Set([9]),
};
const A4: [number, number, number, number] = [0, 0, 595, 842];
const ops = (...entries: Array<[number, unknown]>) => ({
  fnArray: entries.map(([op]) => op),
  argsArray: entries.map(([, args]) => args),
});
const image = (x: number, y: number, w: number, h: number) =>
  [
    [OPS.save, null],
    [OPS.transform, [w, 0, 0, h, x, y]],
    [9, null],
    [OPS.restore, null],
  ] as Array<[number, unknown]>;

describe("classifyPage", () => {
  it.each([
    ["a full-page image with a scanner's stamp", { chars: 40, coverage: 0.98, ink: null }, "scan"],
    [
      "a page with real text beside a large photo",
      { chars: 900, coverage: 0.7, ink: null },
      "text",
    ],
    ["a short page of text", { chars: 12, coverage: 0, ink: null }, "text"],
    ["outlined text with no text layer", { chars: 0, coverage: 0, ink: 0.04 }, "scan"],
    ["an empty sheet", { chars: 0, coverage: 0, ink: 0.0001 }, "blank"],
    ["a page with one large short word", { chars: 4, coverage: 0, ink: null }, "text"],
  ])("calls %s a %s page", (_label, input, kind) => {
    expect(classifyPage(input)).toBe(kind);
  });

  it("asks for a render only when neither text nor images decide", () => {
    expect(classifyPage({ chars: 0, coverage: 0.1, ink: null })).toBe("needs-ink");
  });
});

describe("imageCoverage", () => {
  it("measures a full-page image as the whole page", () => {
    expect(imageCoverage(A4, ops(...image(0, 0, 595, 842)), OPS)).toBeCloseTo(1);
  });

  it("clips an image to the page box, so off-page paint never counts", () => {
    expect(imageCoverage(A4, ops(...image(-297.5, 0, 595, 842)), OPS)).toBeCloseTo(0.5);
  });

  it("applies a form's matrix only until the form ends", () => {
    const list = ops(
      [OPS.formBegin, [[0.5, 0, 0, 0.5, 0, 0], null]],
      ...image(0, 0, 595, 842),
      [OPS.formEnd, null],
      ...image(0, 0, 595, 421),
    );
    expect(imageCoverage(A4, list, OPS)).toBeCloseTo(0.75);
  });

  it("caps overlapping images at the whole page and ignores malformed matrices", () => {
    const list = ops(...image(0, 0, 595, 842), ...image(0, 0, 595, 842), [OPS.transform, ["x"]]);
    expect(imageCoverage(A4, list, OPS)).toBe(1);
  });
});

describe("inkShare", () => {
  const page = (pixels: number[]) => Uint8Array.from(pixels.flatMap((v) => [v, v, v, 255]));

  it("is near zero on an empty grey scan", () => {
    expect(inkShare(page(Array.from({ length: 100 }, () => 200)))).toBe(0);
  });

  it("counts pixels clearly darker than the paper", () => {
    expect(
      inkShare(
        page([...Array.from({ length: 90 }, () => 230), ...Array.from({ length: 10 }, () => 20)]),
      ),
    ).toBeCloseTo(0.1);
  });
});

it("strips NUL and other control characters but keeps line breaks and tabs", () => {
  expect(stripControlCharacters("a\u0000b\u0007c\td\ne\r\u007f")).toBe("abc\td\ne\r");
});
