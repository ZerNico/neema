import { describe, expect, it } from "vitest";
import { hexToHsv, hsvToHex } from "./color.ts";

describe("colour conversions", () => {
  it("turn hex codes into HSV and back, upper case as a sheet keeps them", () => {
    for (const hex of ["#000000", "#FFFFFF", "#4472C4", "#C00000", "#92D050", "#7F7F7F"])
      expect(hsvToHex(hexToHsv(hex)!)).toBe(hex);
    expect(hsvToHex(hexToHsv("ff0000")!)).toBe("#FF0000");
    expect(hexToHsv("#ff0000")).toEqual({ h: 0, s: 1, v: 1 });
  });

  it("read only six-digit codes", () => {
    expect([hexToHsv("#fff"), hexToHsv("red"), hexToHsv("#12345g")]).toEqual([null, null, null]);
  });
});
