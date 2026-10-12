import { describe, expect, it } from "vitest";
import { literalReplacementSize } from "./literal-replacement.ts";

describe("literal replacement measurement", () => {
  it.each([
    ["aaaaa", "aa", "é", true, 2],
    ["aaaaa", "aa", "é", false, 1],
    ["😀😀", "\ud83d", "x", true, 2],
    ["😀😀", "\ude00", "", true, 2],
    ["\ud83dx\ude00", "x", "", false, 1],
    ["x\ude00", "x", "\ud83d", false, 1],
    ["\ud83dx", "x", "\ude00", false, 1],
    ["\ud83dx\ude00x", "x", "", true, 2],
    ["target", "target", "$& $$ $` $' $1", false, 1],
    ["text", "missing", "bigger", true, 0],
  ] as const)("measures %j with %j -> %j (all %s)", (text, before, after, all, replacements) => {
    const actual = all ? text.replaceAll(before, () => after) : text.replace(before, () => after);
    expect(literalReplacementSize(text, before, after, all)).toEqual({
      bytes: Buffer.byteLength(actual, "utf8"),
      replacements,
    });
  });

  it("counts nonoverlapping matches without constructing expanded text", () => {
    expect(literalReplacementSize("a".repeat(1_000), "a", "é".repeat(2_000), true)).toEqual({
      bytes: 4_000_000,
      replacements: 1_000,
    });
  });
});
