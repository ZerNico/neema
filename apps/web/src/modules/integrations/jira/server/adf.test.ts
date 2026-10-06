import { describe, expect, it } from "vitest";
import { adfToMarkdown, markdownToAdf, type AdfNode } from "./adf.ts";

const text = (value: string, marks?: AdfNode["marks"]): AdfNode => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
});

describe("markdownToAdf", () => {
  it("writes blocks and marks where ADF allows them", () => {
    const doc = markdownToAdf(
      "# Plan\n\nShip **now**, see [docs](https://x.example) and `npm i`.\n\n- one\n  - nested\n\n3. three\n\n```ts\nlet a = 1;\n```\n\n> ## Quoted heading\n\n---",
    );
    expect(doc.content).toEqual([
      { type: "heading", attrs: { level: 1 }, content: [text("Plan")] },
      {
        type: "paragraph",
        content: [
          text("Ship "),
          text("now", [{ type: "strong" }]),
          text(", see "),
          text("docs", [{ type: "link", attrs: { href: "https://x.example" } }]),
          text(" and "),
          text("npm i", [{ type: "code" }]),
          text("."),
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [text("one")] },
              {
                type: "bulletList",
                content: [
                  { type: "listItem", content: [{ type: "paragraph", content: [text("nested")] }] },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { order: 3 },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [text("three")] }] }],
      },
      { type: "codeBlock", attrs: { language: "ts" }, content: [text("let a = 1;")] },
      // A quote holds no heading in ADF.
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [text("Quoted heading", [{ type: "strong" }])] }],
      },
      { type: "rule" },
    ]);
  });

  it("keeps a code mark to itself and a link", () => {
    const doc = markdownToAdf("**[`x`](https://x.example)**");
    expect(doc.content[0]!.content).toEqual([
      text("x", [{ type: "link", attrs: { href: "https://x.example" } }, { type: "code" }]),
    ]);
  });

  it("writes task lists and tables", () => {
    const doc = markdownToAdf("- [x] done\n- [ ] open\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(doc.content[0]).toMatchObject({
      type: "taskList",
      content: [
        { type: "taskItem", attrs: { state: "DONE" }, content: [text("done")] },
        { type: "taskItem", attrs: { state: "TODO" }, content: [text("open")] },
      ],
    });
    expect(doc.content[1]).toMatchObject({
      type: "table",
      content: [
        { content: [{ type: "tableHeader" }, { type: "tableHeader" }] },
        { content: [{ type: "tableCell" }, { type: "tableCell" }] },
      ],
    });
  });

  it("never writes an empty text node", () => {
    const empty = JSON.stringify(markdownToAdf("****\n\n`` ``\n\n\n"));
    expect(empty).not.toContain('"text":""');
  });
});

describe("adfToMarkdown", () => {
  it("reads what the converter writes back as the same Markdown", () => {
    const markdown =
      "# Plan\n\nShip **now**, see [docs](https://x.example) and `npm i`.\n\n- one\n  - nested\n\nTasks:\n\n- [x] done\n- [ ] open\n\n```ts\nlet a = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(adfToMarkdown(markdownToAdf(markdown))).toBe(markdown);
  });

  it("reads Jira's own nodes and keeps the text of unknown ones", () => {
    expect(
      adfToMarkdown({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "mention", attrs: { id: "abc", text: "@Ana Lopez" } },
              text(" moved it "),
              { type: "status", attrs: { text: "IN REVIEW" } },
              { type: "hardBreak" },
              { type: "inlineCard", attrs: { url: "https://acme.atlassian.net/browse/X-1" } },
            ],
          },
          {
            type: "panel",
            attrs: { panelType: "warning" },
            content: [{ type: "paragraph", content: [text("Careful")] }],
          },
          { type: "mediaSingle", content: [{ type: "media", attrs: { id: "m" } }] },
          { type: "somethingNew", content: [{ type: "paragraph", content: [text("still here")] }] },
        ],
      }),
    ).toBe(
      "@Ana Lopez moved it [IN REVIEW]\nhttps://acme.atlassian.net/browse/X-1\n\n> **Warning:** Careful\n\n[attachment]\n\nstill here",
    );
    expect(adfToMarkdown(null)).toBe("");
  });
});
