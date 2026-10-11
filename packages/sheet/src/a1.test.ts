import { describe, expect, it } from "vitest";
import { boxArea, boxRef, columnIndex, columnLetters, parseCell, parseRange } from "./a1.ts";

describe("A1 addresses", () => {
  it("converts column letters both ways, past Z and at Excel's last column", () => {
    expect(columnIndex("A")).toBe(1);
    expect(columnIndex("AB")).toBe(28);
    expect(columnLetters(28)).toBe("AB");
    expect(columnLetters(16_384)).toBe("XFD");
    expect(columnIndex(columnLetters(703))).toBe(703);
  });

  it("reads cells and ranges with either corner first, and refuses what is past the grid", () => {
    expect(parseCell("$b$2")).toEqual({ row: 2, column: 2 });
    expect(parseCell("XFE1")).toBeNull();
    expect(parseRange("D9:A1")).toEqual({ top: 1, left: 1, bottom: 9, right: 4 });
    expect(parseRange("A1:B2:C3")).toBeNull();
  });

  it("writes a box back and measures it", () => {
    const box = parseRange("A1:D9")!;
    expect(boxRef(box)).toBe("A1:D9");
    expect(boxRef(parseRange("C3")!)).toBe("C3");
    expect(boxArea(box)).toBe(36);
  });
});
