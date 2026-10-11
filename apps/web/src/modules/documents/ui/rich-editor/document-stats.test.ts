import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../editor/markdown.ts";
import { countWords, documentCounts, documentHeadings } from "./document-stats.ts";

describe("a document's statistics", () => {
  it("counts words by the language's boundaries, punctuation aside", () => {
    expect(countWords("Ship it; on Friday, at noon!")).toBe(6);
    expect(countWords("don't stop")).toBe(2);
    expect(countWords("")).toBe(0);
  });

  it("counts a document's words and characters, block breaks aside", () => {
    expect(documentCounts(parseMarkdown("# Plan\n\nShip **it** soon\n\n- one"))).toEqual({
      words: 5,
      characters: 19,
    });
  });

  it("lists every heading in order, with its level and where its text starts", () => {
    const doc = parseMarkdown("# Plan\n\nText\n\n## Risks\n\n> ### Quoted");
    const headings = documentHeadings(doc);
    expect(headings.map(({ level, text }) => [level, text])).toEqual([
      [1, "Plan"],
      [2, "Risks"],
      [3, "Quoted"],
    ]);
    expect(doc.textBetween(headings[1]!.pos, headings[1]!.pos + 5)).toBe("Risks");
  });
});
