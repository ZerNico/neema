import { describe, expect, it } from "vitest";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  prefixTsQuery,
  searchTerms,
  snippetFromHeadline,
} from "./text.ts";

describe("prefixTsQuery", () => {
  it("prefix-matches every term of any script", () => {
    expect(prefixTsQuery("Koffer Größen")).toBe("koffer:* & größen:*");
    expect(prefixTsQuery("東京 タワー")).toBe("東京:* & タワー:*");
  });

  it("keeps tsquery operators out of the query", () => {
    expect(prefixTsQuery("a & b | !c:* (d) 'e'")).toBe("a:* & b:* & c:* & d:* & e:*");
    expect(prefixTsQuery("  ++ -- ")).toBeNull();
  });

  it("folds compatibility forms and caps the number of terms", () => {
    expect(searchTerms("ｆｕｌｌ ﬁle")).toEqual(["full", "file"]);
    expect(searchTerms("a b c d e f g h i j")).toHaveLength(8);
  });
});

describe("snippetFromHeadline", () => {
  it("turns delimiters into ranges over the plain text", () => {
    const snippet = snippetFromHeadline(
      `Das ${HIGHLIGHT_START}Handgepäck${HIGHLIGHT_END} darf ${HIGHLIGHT_START}10${HIGHLIGHT_END} kg`,
    );
    expect(snippet.text).toBe("Das Handgepäck darf 10 kg");
    expect(snippet.highlights.map(([start, end]) => snippet.text.slice(start, end))).toEqual([
      "Handgepäck",
      "10",
    ]);
  });

  it("drops an empty or unterminated highlight", () => {
    expect(
      snippetFromHeadline(`a ${HIGHLIGHT_START}${HIGHLIGHT_END}b ${HIGHLIGHT_START}c`),
    ).toEqual({
      text: "a b c",
      highlights: [],
    });
  });

  it("counts ranges in the same units string slicing uses", () => {
    const snippet = snippetFromHeadline(`😀 ${HIGHLIGHT_START}match${HIGHLIGHT_END}`);
    expect(snippet.text.slice(...snippet.highlights[0]!)).toBe("match");
  });
});
