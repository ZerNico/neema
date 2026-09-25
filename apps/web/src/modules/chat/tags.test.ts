import { describe, expect, it } from "vitest";
import { findTags, splitMessageTags, tagMarkup, tagWords } from "./tags.ts";

const contracts = { kind: "collection", id: "col-1", name: "Q3 Contracts" } as const;
const review = { kind: "skill", id: "skill-1", name: "review" } as const;

describe("message tags", () => {
  it("writes and finds skill and collection links, repeats included", () => {
    const text = `Use ${tagMarkup(review)} on ${tagMarkup(contracts)} and ${tagMarkup(review)}`;
    expect(text).toBe(
      "Use [/review](/skills/skill-1) on [#Q3 Contracts](/knowledge/col-1) and [/review](/skills/skill-1)",
    );
    expect(findTags(text)).toEqual([review, contracts, review]);
    expect(tagWords(text)).toBe("Use /review on #Q3 Contracts and /review");
  });

  it("keeps a name's brackets from ending the link", () => {
    const tag = { kind: "collection", id: "col-2", name: "Notes [draft]" } as const;
    expect(findTags(tagMarkup(tag))).toEqual([{ ...tag, name: "Notes  draft" }]);
  });

  it("only takes a prefix that matches its page", () => {
    for (const text of ["[#review](/skills/skill-1)", "[/Contracts](/knowledge/col-1)"])
      expect(findTags(text)).toEqual([]);
  });

  it("splits tags and @integration mentions out of the text and joins back", () => {
    const text = `Ask @Outline about ${tagMarkup(contracts)}, then ${tagMarkup(review)}.`;
    const segments = splitMessageTags(text);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "integration",
      "text",
      "tag",
      "text",
      "tag",
      "text",
    ]);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(new Set(segments.map((segment) => segment.start)).size).toBe(segments.length);
  });
});
