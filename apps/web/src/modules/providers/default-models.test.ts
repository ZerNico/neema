import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { DefaultModelIds, MAX_DEFAULT_MODELS, markDefaultModel } from "./default-models.ts";

const row = (id: string, defaultPriority: number | null = null) => ({ id, defaultPriority });

describe("default model policy", () => {
  it("marks the first row as default and strips the rank", () => {
    const input = [row("c", 0), row("b", 1), row("a")];
    expect(markDefaultModel(input)).toEqual([
      { id: "c", isDefault: true },
      { id: "b", isDefault: false },
      { id: "a", isDefault: false },
    ]);
    expect(markDefaultModel([])).toEqual([]);
  });

  it("accepts an ordered set, including an empty policy", () => {
    const decode = Schema.decodeUnknownSync(DefaultModelIds);
    expect(decode(["b", "a"])).toEqual(["b", "a"]);
    expect(decode([])).toEqual([]);
    expect(decode(Array.from({ length: MAX_DEFAULT_MODELS }, (_, i) => `m${i}`))).toHaveLength(
      MAX_DEFAULT_MODELS,
    );
  });

  it.each([
    ["a", "a"],
    [""],
    [42],
    ["a".repeat(101)],
    Array.from({ length: MAX_DEFAULT_MODELS + 1 }, (_, i) => `m${i}`),
  ])("rejects invalid model order %#", (...input) => {
    expect(() => Schema.decodeUnknownSync(DefaultModelIds)(input)).toThrow();
  });
});
