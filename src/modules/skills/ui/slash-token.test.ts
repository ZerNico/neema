import { describe, expect, it } from "vitest";
import { matchSkillSlash } from "./slash-token.ts";

describe("local skill slash tokens", () => {
  it.each([
    "/",
    "/review",
    "Please /review",
    "First line\n/review",
    "你好 /校对",
    " /review-name_2",
  ])("matches a caret token in %s", (value) => {
    const token = matchSkillSlash(value, value.length, value.length);
    expect(token).not.toBeNull();
    expect(value.slice(token!.start, token!.end)).toBe(`/${token!.query}`);
  });
  it.each([
    "https://example.com/review",
    "path/to/review",
    "//review",
    "word/review",
    "/with.dot",
    `/${"a".repeat(65)}`,
  ])("ignores non-token %s", (value) => {
    expect(matchSkillSlash(value, value.length, value.length)).toBeNull();
  });
  it("matches only the active token without consuming surrounding text", () => {
    expect(matchSkillSlash("Before /rev after", 11, 11)).toEqual({
      start: 7,
      end: 11,
      query: "rev",
    });
    expect(matchSkillSlash("Before /review after", 11, 11)).toBeNull();
  });
  it("does not replace selections or invalid positions", () => {
    expect(matchSkillSlash("/review", 1, 7)).toBeNull();
    expect(matchSkillSlash("/review", -1, -1)).toBeNull();
    expect(matchSkillSlash("/review", 8, 8)).toBeNull();
  });
});
