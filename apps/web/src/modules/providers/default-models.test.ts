import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DefaultModelIds, markDefaultModel } from "./default-models.ts";

const row = (id: string, defaultPriority: number | null = null) => ({ id, defaultPriority });

describe("default model policy", () => {
  it("marks the preferred model without reordering or exposing priorities", () => {
    const input = [row("a"), row("b", 1), row("c", 0)];
    expect(markDefaultModel(input)).toEqual([
      { id: "a", isDefault: false },
      { id: "b", isDefault: false },
      { id: "c", isDefault: true },
    ]);
    expect(input[2]?.defaultPriority).toBe(0);
  });

  it("falls back to display order when none is ranked and handles no models", () => {
    expect(markDefaultModel([row("a"), row("b")])).toEqual([
      { id: "a", isDefault: true },
      { id: "b", isDefault: false },
    ]);
    expect(markDefaultModel([])).toEqual([]);
    expect(markDefaultModel([row("a", 1), row("b", 1)])[0]?.isDefault).toBe(true);
  });

  it("accepts an ordered set, including an empty policy", () => {
    const decode = Schema.decodeUnknownSync(DefaultModelIds);
    expect(decode(["b", "a"])).toEqual(["b", "a"]);
    expect(decode([])).toEqual([]);
    expect(decode(Array.from({ length: 100 }, (_, i) => `m${i}`))).toHaveLength(100);
  });

  it.each([
    ["a", "a"],
    [""],
    [42],
    ["a".repeat(101)],
    Array.from({ length: 101 }, (_, i) => `m${i}`),
  ])("rejects invalid model order %#", (...input) => {
    expect(() => Schema.decodeUnknownSync(DefaultModelIds)(input)).toThrow();
  });
});
