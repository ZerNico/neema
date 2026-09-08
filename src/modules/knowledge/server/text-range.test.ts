import { describe, expect, it } from "vitest";
import { textEnd, textPrefix } from "./text-range.ts";

describe("UTF-16 text boundaries", () => {
  it("keeps complete supplementary characters and clamps bounds", () => {
    const text = "a😀b";
    expect(textEnd(text, -1)).toBe(0);
    expect(textEnd(text, 2)).toBe(1);
    expect(textEnd(text, 3)).toBe(3);
    expect(textEnd(text, 100)).toBe(4);
    expect(textPrefix(text, 2)).toBe("a");
    expect(textPrefix(text, 3)).toBe("a😀");
    expect(textPrefix("", 1)).toBe("");
  });
});
