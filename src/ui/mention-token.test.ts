import { describe, expect, it } from "vitest";
import { matchMentionToken } from "./mention-token.ts";

const slash = (value: string, start = value.length, end = start) =>
  matchMentionToken(value, start, end, "/");

describe("mention tokens", () => {
  it.each([
    "/",
    "/review",
    "Please /review",
    "First line\n/review",
    "你好 /校对",
    " /review-name_2",
  ])("matches a caret token in %s", (value) => {
    const token = slash(value, value.length, value.length);
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
    expect(slash(value, value.length, value.length)).toBeNull();
  });
  it("matches only the active token without consuming surrounding text", () => {
    expect(slash("Before /rev after", 11, 11)).toEqual({
      start: 7,
      end: 11,
      query: "rev",
    });
    expect(slash("Before /review after", 11, 11)).toBeNull();
  });
  it("does not replace selections or invalid positions", () => {
    expect(slash("/review", 1, 7)).toBeNull();
    expect(slash("/review", -1, -1)).toBeNull();
    expect(slash("/review", 8, 8)).toBeNull();
  });

  it("works for any trigger character, and only its own", () => {
    const hash = (value: string) => matchMentionToken(value, value.length, value.length, "#");
    expect(hash("Use #contracts")).toEqual({ start: 4, end: 14, query: "contracts" });
    // Mid-word is ordinary text, so an issue reference never opens the list.
    expect(hash("issue#5")).toBeNull();
    // Triggers do not see each other's tokens.
    expect(hash("/review")).toBeNull();
    expect(slash("#contracts")).toBeNull();
  });
});
