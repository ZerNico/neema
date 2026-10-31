import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown.ts";
import { plainTextMarkdown } from "./plain-text.ts";

/** Each paragraph's text, a hard break read as a newline. */
const paragraphs = (markdown: string) => {
  const doc = parseMarkdown(markdown);
  const found: string[] = [];
  doc.forEach((block) => {
    let text = "";
    block.descendants((node) => {
      if (node.type.name === "hardBreak") text += "\n";
      else if (node.isText) {
        expect(node.marks).toEqual([]);
        text += node.text;
      }
      return true;
    });
    found.push(`${block.type.name}:${text}`);
  });
  return found;
};

describe("plainTextMarkdown", () => {
  it("reads back as the same text, with nothing turned into formatting", () => {
    const text = [
      "# not a heading",
      "*not* _emphasis_ `code` [link](x) <b>tag</b> $x$ ~~s~~",
      "- not a list",
      "1. not numbered",
      "",
      "> not a quote",
      "    indented | pipe \\ backslash",
      "",
      "",
      "---",
    ].join("\r\n");
    expect(paragraphs(plainTextMarkdown(text))).toEqual([
      "paragraph:# not a heading\n*not* _emphasis_ `code` [link](x) <b>tag</b> $x$ ~~s~~\n- not a list\n1. not numbered",
      "paragraph:> not a quote\nindented | pipe \\ backslash",
      "paragraph:---",
    ]);
  });

  it("makes nothing of empty text", () => {
    expect(plainTextMarkdown("\n  \n")).toBe("");
  });
});
