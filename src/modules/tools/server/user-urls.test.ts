import { describe, expect, it } from "vitest";
import { canonicalUserUrl, extractUserMessageUrls, extractUserUrls } from "./user-urls.ts";

describe("canonicalUserUrl", () => {
  it("normalizes HTTP(S) URLs and removes fragments", () => {
    expect(canonicalUserUrl(" https://Example.COM:443/docs#install ")).toBe(
      "https://example.com/docs",
    );
    expect(canonicalUserUrl("http://example.com:80")).toBe("http://example.com/");
  });

  it("trims prose punctuation without clipping balanced URL characters", () => {
    expect(canonicalUserUrl("https://example.com/docs_(v2)).")).toBe(
      "https://example.com/docs_(v2)",
    );
  });

  it("rejects non-web and malformed URLs", () => {
    expect(canonicalUserUrl("ftp://example.com/file")).toBeNull();
    expect(canonicalUserUrl("not a URL")).toBeNull();
  });
});

describe("extractUserUrls", () => {
  it("finds bare and Markdown URLs across user messages in first-seen order", () => {
    expect(
      extractUserUrls([
        "Read https://example.com/one, then [the docs](https://docs.example.com/api_(v2)).",
        "A follow-up about <https://example.com/one#details> and https://other.example/x!",
      ]),
    ).toEqual([
      "https://example.com/one",
      "https://docs.example.com/api_(v2)",
      "https://other.example/x",
    ]);
  });

  it("ignores text without explicit HTTP(S) URLs", () => {
    expect(extractUserUrls(["Visit example.com", "Try ftp://example.com/file"])).toEqual([]);
  });
});

describe("extractUserMessageUrls", () => {
  it("keeps URLs from current and earlier user turns but excludes assistant output", () => {
    expect(
      extractUserMessageUrls([
        { role: "user", content: "Earlier: https://earlier.example/docs" },
        { role: "assistant", content: "Try https://invented.example/search" },
        { role: "user", content: "Current: https://current.example/page" },
      ]),
    ).toEqual(["https://earlier.example/docs", "https://current.example/page"]);
  });
});
