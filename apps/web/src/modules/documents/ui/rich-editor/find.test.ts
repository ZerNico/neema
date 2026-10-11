import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../editor/markdown.ts";
import { findMatches } from "./find.ts";

const texts = (markdown: string, query: string, caseSensitive = false, wholeWord = false) => {
  const doc = parseMarkdown(markdown);
  return findMatches(doc, query, { caseSensitive, wholeWord }).map((match) =>
    doc.textBetween(match.from, match.to),
  );
};

describe("finding text in a document", () => {
  it("finds every match in order, ignoring case unless asked", () => {
    expect(texts("Plan the **plan**\n\n- PLAN B", "plan")).toEqual(["Plan", "plan", "PLAN"]);
    expect(texts("Plan the **plan**\n\n- PLAN B", "plan", true)).toEqual(["plan"]);
  });

  it("matches whole words only when asked, and never across blocks or chips", () => {
    expect(texts("planet plan planning", "plan", false, true)).toEqual(["plan"]);
    expect(texts("end of one\n\nline two", "one line")).toEqual([]);
    expect(texts("cost $x$ total", "cost x")).toEqual([]);
  });
});
