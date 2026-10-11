import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { Markdown, MarkdownManager } from "@tiptap/markdown";
import { StarterKit } from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { Transform } from "@tiptap/pm/transform";
import { documentExtensions } from "./extensions.ts";
import {
  documentSchema,
  normalizeMarkdown,
  parseMarkdown,
  replaceDifference,
  toMarkdown,
  toModelMarkdown,
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

describe("document Markdown", () => {
  it("writes &, < and > as themselves, escaping only what would start a tag or entity", () => {
    const text = "A & B < C > D, a <div> tag, &amp; spelled out, x<y";
    const doc = documentSchema.node("doc", null, [
      documentSchema.node("paragraph", null, [documentSchema.text(text)]),
    ]);
    expect(toMarkdown(doc)).toBe("A & B < C > D, a \\<div> tag, \\&amp; spelled out, x\\<y");
    expect(parseMarkdown(toMarkdown(doc)).firstChild!.textContent).toBe(text);
    expect(toMarkdown(parseMarkdown("| a & b | c |\n| --- | --- |\n| 1 < 2 | 3 |"))).toContain(
      "| a & b | c   |",
    );
  });

  it("reads back what it was written in canonical form", () => {
    expect(normalizeMarkdown(SAMPLE)).toBe(SAMPLE);
    expect(toMarkdown(parseMarkdown(SAMPLE))).toBe(SAMPLE);
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

  it("leaves a shortcode typed into code as it is in the people's Markdown", () => {
    const markdown = "```\nconst due = '[date value=\"2026-10-09\"]';\n```";
    expect(toMarkdown(parseMarkdown(markdown))).toBe(markdown);
  });

  it("reads and writes chips as shortcodes for the model, and as text for people", () => {
    const markdown = 'Ship on [date value="2026-10-20"] with [@ id="u1" label="Ada"].';
    const doc = parseMarkdown(markdown);
    const inline = doc.firstChild!;
    expect(inline.child(1).type.name).toBe("dateChip");
    expect(inline.child(1).attrs.value).toBe("2026-10-20");
    expect(inline.child(3).type.name).toBe("mention");
    expect(toModelMarkdown(doc)).toBe(markdown);
    expect(toMarkdown(doc)).toBe("Ship on 2026-10-20 with @Ada.");
  });

  it("reads and writes sheet embeds as shortcodes for the model, and as a plain line for people", () => {
    const markdown = [
      "Totals:",
      '[sheet id="sheet-1" range="\'Q3 \\"final\\"\'!A1:D9"]',
      '[sheet id="sheet-1" chart="chart-2"]',
      "After.",
    ].join("\n\n");
    const doc = parseMarkdown(markdown);
    expect(doc.childCount).toBe(4);
    expect(doc.child(1).type.name).toBe("sheetEmbed");
    expect(doc.child(1).attrs).toMatchObject({
      sheet: "sheet-1",
      range: "'Q3 \"final\"'!A1:D9",
      chart: null,
    });
    expect(doc.child(2).attrs).toMatchObject({ sheet: "sheet-1", range: null, chart: "chart-2" });
    expect(toModelMarkdown(doc)).toBe(markdown);
    // People's Markdown has no values to show, so it names what was there,
    // and that line reads back as text, never as an embed.
    const plain = toMarkdown(doc);
    expect(plain).toBe("Totals:\n\n*Sheet range 'Q3 \"final\"'!A1:D9*\n\n*Sheet chart*\n\nAfter.");
    const reread = parseMarkdown(plain);
    reread.descendants((node) => {
      expect(node.type.name).not.toBe("sheetEmbed");
      return true;
    });
  });

  it("leaves a sheet shortcode as text when it names both or neither of a range and a chart", () => {
    for (const markdown of [
      '[sheet id="s" range="A!A1" chart="c"]',
      '[sheet id="s"]',
      'Inline [sheet id="s" range="A!A1"] stays text',
    ]) {
      const doc = parseMarkdown(markdown);
      expect(doc.firstChild!.type.name).toBe("paragraph");
    }
  });

  it("keeps raw HTML as text instead of markup", () => {
    const written = normalizeMarkdown("before <b>x</b>\n\n<script>alert(1)</script>");
    expect(written).toBe("before \\<b>x\\</b>\n\n\\<script>alert(1)\\</script>");
    // Read again, it is still the same text, not markup.
    expect(normalizeMarkdown(written)).toBe(written);
    expect(parseMarkdown(written).firstChild!.textContent).toBe("before <b>x</b>");
  });

  it("changes only the range that differs, so text and cursors around it stay put", () => {
    const doc = parseMarkdown(SAMPLE);
    const next = parseMarkdown(SAMPLE.replace("Intro with", "An intro with"));
    const tr = replaceDifference(new Transform(doc), next);

    expect(toMarkdown(tr.doc)).toBe(toMarkdown(next));
    expect(tr.steps).toHaveLength(1);
    // A cursor in the task list further down maps straight through.
    let task = -1;
    doc.descendants((node, position) => {
      if (task < 0 && node.isText && node.text === "open task") task = position;
    });
    const before = EditorState.create({
      doc,
      selection: TextSelection.create(doc, task + 2),
    });
    const after = before.apply(before.tr.step(tr.steps[0]!));
    expect(after.doc.textBetween(after.selection.from - 2, after.selection.from + 7)).toBe(
      "open task",
    );
  });

  it("writes nothing when the documents already agree, and empties for empty Markdown", () => {
    const doc = parseMarkdown("# Title");
    expect(replaceDifference(new Transform(doc), parseMarkdown("# Title")).steps).toHaveLength(0);
    const emptied = replaceDifference(new Transform(doc), parseMarkdown("  \n"));
    expect(toMarkdown(emptied.doc)).toBe("");
  });
});

describe("callouts, collapsible sections and footnotes", () => {
  it("write a callout as GitHub's alert and read it back, blocks and kind kept", () => {
    const markdown = "> [!WARNING]\n> Back up first.\n>\n> - one\n> - two";
    const doc = parseMarkdown(markdown);
    expect(doc.firstChild!.type.name).toBe("callout");
    expect(doc.firstChild!.attrs.kind).toBe("warning");
    expect(toMarkdown(doc)).toBe(markdown);
    // A plain quote stays a quote.
    expect(parseMarkdown("> just a quote").firstChild!.type.name).toBe("blockquote");
  });

  it("write a collapsible section as <details> and read it back, nested ones too", () => {
    const markdown =
      "<details>\n<summary>More **info**</summary>\n\nOuter text\n\n<details>\n<summary>Inner</summary>\n\nInner text\n\n</details>\n\n</details>";
    const doc = parseMarkdown(markdown);
    const section = doc.firstChild!;
    expect(section.type.name).toBe("details");
    expect(section.firstChild!.textContent).toBe("More info");
    expect(section.lastChild!.lastChild!.type.name).toBe("details");
    expect(toMarkdown(doc)).toBe(markdown);
  });

  it("write footnotes inline for the model and numbered for people, reading both", () => {
    const doc = parseMarkdown("Shipped^[Per the 3\\] release notes.] on time^[Ask Ada.].");
    expect(toModelMarkdown(doc)).toBe("Shipped^[Per the 3\\] release notes.] on time^[Ask Ada.].");
    const people = toMarkdown(doc);
    expect(people).toBe(
      "Shipped[^1] on time[^2].\n\n[^1]: Per the 3] release notes.\n[^2]: Ask Ada.",
    );
    expect(toModelMarkdown(parseMarkdown(people))).toBe(toModelMarkdown(doc));
  });

  it("leave a reference with no definition as text, as a chat citation pasted in", () => {
    const doc = parseMarkdown("As reported[^3].");
    expect(doc.firstChild!.childCount).toBe(1);
    expect(toMarkdown(doc)).toBe("As reported\\[^3\\].");
  });
});

describe("underline and highlight", () => {
  it("write as the tags GitHub draws and read back, formatting inside kept", () => {
    const markdown = "Read <u>the **whole** brief</u> and <mark>this line</mark>.";
    const doc = parseMarkdown(markdown);
    const marks = new Set<string>();
    doc.descendants((node) => {
      for (const mark of node.marks) marks.add(mark.type.name);
      return true;
    });
    expect([...marks].toSorted()).toEqual(["bold", "highlight", "underline"]);
    expect(toMarkdown(doc)).toBe(markdown);
  });

  it("never read plus signs as underline, as upstream's ++text++ did", () => {
    const doc = parseMarkdown("C++ and C++ are fine");
    expect(doc.firstChild!.textContent).toBe("C++ and C++ are fine");
    expect(doc.firstChild!.firstChild!.marks).toEqual([]);
  });
});
