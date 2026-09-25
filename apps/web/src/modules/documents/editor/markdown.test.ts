import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { documentExtensions } from "./extensions.ts";
import {
  documentSchema,
  documentTree,
  normalizeMarkdown,
  readMarkdown,
  toMarkdown,
  writeMarkdown,
} from "./markdown.ts";

const SAMPLE = [
  "# Launch plan",
  "",
  "Intro with **bold**, *italic*, ~~strike~~, `code` and a [link](https://example.test).",
  "",
  "- first",
  "- second",
  "  - nested",
  "",
  "1. one",
  "2. two",
  "",
  "- [ ] open task",
  "- [x] done task",
  "",
  "> quoted",
  "",
  "```ts",
  "const a = 1;",
  "```",
  "",
  "| a   | b   |",
  "| --- | --- |",
  "| 1   | 2   |",
  "",
  "---",
  "",
  "A line  ",
  "after a hard break, and ![a chart](https://example.test/chart.png) inline.",
].join("\n");

const cell = (text: string) => ({
  type: "tableCell",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
const row = (...texts: string[]) => ({ type: "tableRow", content: texts.map(cell) });

const withDocument = (markdown: string) => {
  const doc = new Y.Doc();
  writeMarkdown(doc, markdown);
  return doc;
};

describe("document Markdown", () => {
  it("reads back what it was written in canonical form", () => {
    expect(normalizeMarkdown(SAMPLE)).toBe(SAMPLE);
    expect(readMarkdown(withDocument(SAMPLE))).toBe(SAMPLE);
  });

  it.each([
    ["inline code holding a backtick", "Use `` a`b `` here", "Use ``a`b`` here"],
    ["inline code edged by backticks", "`` `tick` ``", "`` `tick` ``"],
    ["a fence inside a code block", "```\nfence ``` inside\n```", "````\nfence ``` inside\n````"],
    [
      "a pipe in a table cell",
      "| a | b |\n| --- | --- |\n| x \\| y | 2 |",
      "| a      | b   |\n| ------ | --- |\n| x \\| y | 2   |",
    ],
    [
      "a pipe in code in a table cell",
      "| c |\n| --- |\n| `a|b` |",
      "| c      |\n| ------ |\n| `a\\|b` |",
    ],
    ["literal emphasis characters", "2 * 3 and \\*not bold\\*", "2 \\* 3 and \\*not bold\\*"],
  ])("keeps %s intact", (_, markdown, canonical) => {
    const once = normalizeMarkdown(markdown);
    expect(once).toBe(canonical);
    expect(normalizeMarkdown(once)).toBe(once);
  });

  it("writes a table without header cells with its first row as the header", () => {
    const node = documentSchema.nodeFromJSON({
      type: "doc",
      content: [{ type: "table", content: [row("Area", "Owner"), row("Sync", "Grace")] }],
    });
    expect(toMarkdown(node)).toBe("| Area | Owner |\n| ---- | ----- |\n| Sync | Grace |");
  });

  it.each([
    ["loose numbered items", "1. one\n\n2. two\n\nAfter"],
    ["a task list, then prose", "- [ ] a\n- [x] b\n\nProse after."],
    [
      "nested tasks with code",
      "- [ ] a\n  - [x] b\n\n    ```\n    - [ ] not a task\n    ```\n- [ ] c",
    ],
    ["tasks, then a bullet and a numbered list", "- [ ] a\n\n- plain\n\n1. one\n2) two"],
    ["a list running into a table", "1. one\n2. two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"],
    ["text that only looks like a list", "Step 1. do it\n\n  1. indented\n\n- [x]no space"],
  ])("parses %s as upstream does, reading less of the document", (_, markdown) => {
    // Upstream's own list and table tokenizers, which read the whole rest of the document.
    const upstream = new MarkdownManager({
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table,
        TableRow,
        TableHeader,
        TableCell,
        Markdown,
      ],
    });
    const ours = new MarkdownManager({ extensions: documentExtensions });
    expect(ours.parse(markdown)).toEqual(upstream.parse(markdown));
  });

  it("keeps raw HTML as text instead of markup", () => {
    expect(normalizeMarkdown("before <b>x</b>\n\n<script>alert(1)</script>")).toBe(
      "before &lt;b&gt;x&lt;/b&gt;\n\n&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("changes only the block that differs, so others keep their place", () => {
    const doc = withDocument(SAMPLE);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Y.encodeStateAsUpdate(doc));
    const before = documentTree(doc).toArray();
    const vector = Y.encodeStateVector(doc);

    const next = SAMPLE.replace("- [ ] open task", "- [x] open task");
    writeMarkdown(doc, next);

    expect(readMarkdown(doc)).toBe(next);
    const after = documentTree(doc).toArray();
    // Ticking a task sets an attribute in place: every top-level block is the same shared item.
    const changed = before.filter((block, index) => after[index] !== block);
    expect(changed).toHaveLength(0);
    const delta = Y.encodeStateAsUpdate(doc, vector);
    expect(delta.length).toBeLessThan(Y.encodeStateAsUpdate(doc).length / 10);
    Y.applyUpdate(replica, delta);
    expect(readMarkdown(replica)).toBe(next);
  });

  it("empties the tree for empty Markdown", () => {
    const doc = withDocument("# Title");
    writeMarkdown(doc, "  \n");
    expect(documentTree(doc).length).toBe(0);
    expect(readMarkdown(doc)).toBe("");
  });
});
