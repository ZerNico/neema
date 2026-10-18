import { loadImage, makeOneCellAnchor, makePictureDrawingItem } from "@office-kit/xlsx/drawing";
import { addWorksheet, createWorkbook } from "@office-kit/xlsx/workbook";
import { describe, expect, it } from "vitest";
import { readImage } from "./file-images.ts";

// A 2×1 PNG, and the same bytes with the header claiming 50 000 pixels a side.
const png = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mP8z8Dwn4GBgQEADgMCAXl3Jk0AAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);
const declaring = (side: number) => {
  const bytes = png.slice();
  new DataView(bytes.buffer).setUint32(16, side);
  new DataView(bytes.buffer).setUint32(20, side);
  return bytes;
};

const pictured = (bytes: Uint8Array, format?: "png" | "gif") => {
  const sheet = addWorksheet(createWorkbook(), "Sheet1");
  const item = makePictureDrawingItem(
    makeOneCellAnchor({ from: "B2", widthPx: 40, heightPx: 20 }),
    loadImage(bytes, { width: 2, height: 1, ...(format ? { format } : {}) }),
  );
  return readImage(sheet, item);
};

describe("workbook preview pictures", () => {
  it("sends a picture as a data URL of the type its bytes say", () => {
    // Stored as a GIF by name, a PNG by its bytes: the bytes decide.
    expect(pictured(png, "gif")).toMatchObject({
      row: 2,
      col: 2,
      src: expect.stringMatching(/^data:image\/png;base64,/),
    });
  });

  it("leaves out a picture declaring more pixels than a browser should decode", () => {
    expect(pictured(declaring(50_000))).toBeNull();
    expect(pictured(declaring(6_000))).toBeNull();
    expect(pictured(declaring(2_000))).not.toBeNull();
  });
});
