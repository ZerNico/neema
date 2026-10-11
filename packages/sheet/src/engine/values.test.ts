import { describe, expect, it } from "vitest";
import { extent } from "./values.ts";

describe("extent", () => {
  it("finds the smallest and largest of more numbers than a call can take as arguments", () => {
    const numbers = Array.from({ length: 300_000 }, (_, index) => (index % 2 ? index : -index));
    expect(() => Math.max(...numbers)).toThrow(RangeError);
    expect(extent(numbers)).toEqual([-299_998, 299_999]);
  });
});
