import { describe, expect, it } from "vitest";
import { m } from "~/paraglide/messages.js";
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

  it("counts block by block as the whole text reads, rules, tables and code included", () => {
    const doc = parseMarkdown(
      "# Plan\n\nShip it\n\n---\n\n| a | b |\n| --- | --- |\n| one two | three |\n\n```ts\nconst x = 1;\n```\n\n- [ ] task one\n  - nested item",
    );
    const text = doc.textBetween(0, doc.content.size, "\n", " ");
    expect(documentCounts(doc)).toEqual({
      words: countWords(text),
      characters: text.replaceAll("\n", "").length,
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

describe("the word count's wording", () => {
  it("tells one word from several and groups digits by locale", () => {
    expect(m.documents_word_count_total({ words: 2, characters: 1 }, { locale: "en" })).toBe(
      "2 words · 1 character",
    );
    expect(m.documents_word_count_total({ words: 1, characters: 1200 }, { locale: "de" })).toBe(
      "1 Wort · 1.200 Zeichen",
    );
    expect(m.documents_word_count_selected({ selected: 2, words: 5 }, { locale: "de" })).toBe(
      "2 von 5 Wörtern",
    );
  });
});
