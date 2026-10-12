import { MarkdownManager } from "@tiptap/markdown";
import { Lexer } from "marked";
import { describe, expect, it, vi } from "vitest";
import { DocumentLexer } from "./block-start.ts";
import { documentExtensions } from "./extensions.ts";
import { isolatedMarked } from "./isolated-marked.ts";
import { parseMarkdown, toModelMarkdown } from "./markdown.ts";

const BLOCK_PATTERNS = new Set([
  /\n {0,3}> ?\[!/.source,
  /\n<details>[ \t]*\n/i.source,
  /\n\[sheet[ \t]/.source,
]);

/** Search spans, not time or regex-engine instructions. Spies always call the real methods. */
const measureDiscovery = <T>(parse: () => T) => {
  const work = { calls: 0, suffixCharacters: 0, searchedCharacters: 0 };
  const exec = RegExp.prototype.exec;
  const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, src) {
    const start = this.global ? this.lastIndex : 0;
    const match = exec.call(this, src);
    if (BLOCK_PATTERNS.has(this.source)) {
      work.calls++;
      work.suffixCharacters += src.length;
      work.searchedCharacters += (match ? match.index + match[0].length : src.length) - start;
    }
    return match;
  });
  try {
    return { result: parse(), work };
  } finally {
    spy.mockRestore();
  }
};

const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, i) => `Paragraph ${i}`).join("\n\n");

const unindexedMarked = isolatedMarked();
unindexedMarked.Lexer = Lexer;
const unindexed = new MarkdownManager({ extensions: documentExtensions, marked: unindexedMarked });
const indexed = new MarkdownManager({ extensions: documentExtensions, marked: isolatedMarked() });

const HOSTILE = [
  {
    name: "unclosed underline tags",
    markdown: "x " + "<u>a ".repeat(10_000),
    count: 1,
    type: "paragraph",
    first: "x " + "<u>a ".repeat(10_000),
    last: "x " + "<u>a ".repeat(10_000),
  },
  {
    name: "unclosed inline footnotes",
    markdown: "a" + "^[".repeat(20_000),
    count: 1,
    type: "paragraph",
    first: "a" + "^[".repeat(20_000),
    last: "a" + "^[".repeat(20_000),
  },
  {
    name: "six thousand ordinary paragraphs",
    markdown: paragraphs(6_000),
    count: 6_000,
    type: "paragraph",
    first: "Paragraph 0",
    last: "Paragraph 5999",
  },
  {
    name: "two thousand sibling details sections",
    markdown: Array.from(
      { length: 2_000 },
      () => "<details>\n<summary>S</summary>\n\nx\n\n</details>",
    ).join("\n\n"),
    count: 2_000,
    type: "details",
    first: "Sx",
    last: "Sx",
  },
];

describe("document Markdown discovery work", () => {
  it.each([1_000, 2_000, 4_000])("indexes %i ordinary paragraphs only once", (count) => {
    const markdown = paragraphs(count);
    const { result: doc, work } = measureDiscovery(() => parseMarkdown(markdown));
    expect(doc.childCount).toBe(count);
    expect(doc.firstChild!.textContent).toBe("Paragraph 0");
    expect(doc.lastChild!.textContent).toBe(`Paragraph ${count - 1}`);
    expect(work.calls).toBe(3);
    expect(work.suffixCharacters).toBeLessThanOrEqual(3 * markdown.length);
    expect(work.searchedCharacters).toBeLessThanOrEqual(3 * markdown.length);
  });

  it("rejects the former repeated-suffix algorithm with the same work bound", () => {
    const markdown = paragraphs(1_000);
    // A regular marked lexer runs the unchanged search patterns on every suffix.
    const { result: doc, work } = measureDiscovery(() => unindexed.parse(markdown));
    expect(doc.content).toHaveLength(1_000);
    expect(work.calls).toBe(3_000);
    expect(work.suffixCharacters).toBe(22_498_185);
    expect(work.searchedCharacters).toBeGreaterThan(3 * markdown.length);
  });

  // The suite's runner timeout stays separate from these correctness and work assertions.
  it.each(HOSTILE)("parses $name with its structure and discovery bound intact", (fixture) => {
    const { result: doc, work } = measureDiscovery(() => parseMarkdown(fixture.markdown));
    doc.check();
    expect(doc.childCount).toBe(fixture.count);
    expect(doc.firstChild!.textContent).toBe(fixture.first);
    expect(doc.lastChild!.textContent).toBe(fixture.last);
    doc.forEach((node) => {
      expect(node.type.name).toBe(fixture.type);
      if (fixture.type === "details") {
        expect(node.child(0).type.name).toBe("detailsSummary");
        expect(node.child(0).textContent).toBe("S");
        expect(node.child(1).type.name).toBe("detailsContent");
        expect(node.child(1).childCount).toBe(1);
        expect(node.child(1).firstChild!.type.name).toBe("paragraph");
        expect(node.child(1).textContent).toBe("x");
      }
    });
    if (fixture.count === 1)
      doc.descendants((node) => {
        expect(node.marks).toHaveLength(0);
      });
    expect(work.calls).toBeGreaterThan(0);
    expect(work.searchedCharacters).toBeLessThanOrEqual(6 * fixture.markdown.length);
  });

  it("bounds each unclosed underline's closing-tag probe", () => {
    const markdown = HOSTILE[0]!.markdown;
    const indexOf = String.prototype.indexOf;
    const probes: number[] = [];
    const spy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      search,
      from,
    ) {
      if (search === "</u>") probes.push(this.length);
      return indexOf.call(this, search, from);
    });
    try {
      expect(parseMarkdown(markdown).firstChild!.textContent).toBe(markdown);
    } finally {
      spy.mockRestore();
    }
    expect(probes).toHaveLength(10_000);
    expect(Math.max(...probes)).toBeLessThanOrEqual(4_007);
    expect(probes.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(4_007 * 10_000);
  });

  it("bounds each unclosed footnote's closing-bracket probe", () => {
    const markdown = HOSTILE[1]!.markdown;
    const includes = String.prototype.includes;
    const probes: number[] = [];
    const spy = vi.spyOn(String.prototype, "includes").mockImplementation(function (
      this: string,
      search,
      from,
    ) {
      if (search === "]") probes.push(this.length);
      return includes.call(this, search, from);
    });
    try {
      expect(parseMarkdown(markdown).firstChild!.textContent).toBe(markdown);
    } finally {
      spy.mockRestore();
    }
    expect(probes).toHaveLength(20_000);
    expect(Math.max(...probes)).toBeLessThanOrEqual(1_001);
    expect(probes.reduce((total, length) => total + length, 0)).toBeLessThanOrEqual(1_001 * 20_000);
  });

  it("keeps search linear when custom interruptions have no blank lines between them", () => {
    const markdown = Array.from(
      { length: 1_000 },
      (_, i) => `Paragraph ${i}\n[sheet id="s${i}" range="S!A1"]`,
    ).join("\n");
    const { result: doc, work } = measureDiscovery(() => parseMarkdown(markdown));
    expect(doc.childCount).toBe(2_000);
    doc.forEach((node, _offset, index) => {
      expect(node.type.name).toBe(index % 2 ? "sheetEmbed" : "paragraph");
      if (index % 2) expect(node.attrs.sheet).toBe(`s${(index - 1) / 2}`);
    });
    expect(work.searchedCharacters).toBeLessThanOrEqual(6 * markdown.length);
  });

  it.each([
    ["callout", "> [!NOTE]\n> Body"],
    ["details", "<details>\n<summary>S</summary>\n\nBody\n\n</details>"],
    ["sheetEmbed", '[sheet id="s" chart="c"]'],
  ])("finds a distant %s that interrupts a single paragraph", (type, block) => {
    const prefix = "ordinary text ".repeat(2_000).trimEnd();
    const markdown = `${prefix}\n${block}\n\nAfter`;
    const doc = parseMarkdown(markdown);
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).textContent).toBe(prefix.trimEnd());
    expect(doc.child(1).type.name).toBe(type);
    expect(doc.child(2).textContent).toBe("After");
    expect(indexed.parse(markdown)).toEqual(unindexed.parse(markdown));
  });

  it.each([
    [
      "nested details, fenced openings and a later embed",
      'Before\n\n<details>\n<summary>Outer</summary>\n\nBody\n\n<details>\n<summary>Inner</summary>\n\nText\n\n</details>\n\n```html\n<details>\n</details>\n[sheet id="code" chart="c"]\n> [!TIP]\n```\n\n</details>\n\nAfter\n[sheet id="live" chart="c"]',
    ],
    [
      "rewritten list and quote bodies",
      'Before\n\n- item\n  > [!TIP]\n  > Text\n  >\n  > [sheet id="quoted" range="S!A1"]\n\nAfter\n[sheet id="tail" chart="c"]',
    ],
    [
      "overlapping details discovery newlines",
      "Before\n<details>\n<details>\n<summary>Inner</summary>\n\nText\n\n</details>\n\nAfter",
    ],
    [
      "case-insensitive details with CRLF and trailing whitespace",
      "Before\r\n<DETAILS> \t\r\n<SUMMARY>Title</SUMMARY>\r\n\r\nBody\r\n\r\n</DETAILS>\r\n\r\nAfter",
    ],
  ])("preserves baseline parsing for %s", (_name, markdown) => {
    expect(indexed.parse(markdown)).toEqual(unindexed.parse(markdown));
    const doc = parseMarkdown(markdown);
    doc.check();
    const canonical = toModelMarkdown(doc);
    expect(toModelMarkdown(parseMarkdown(canonical))).toBe(canonical);
  });

  it("leaves indexed openings inside a fence as code, then finds the real embed", () => {
    const code =
      '<details>\n<summary>S</summary>\n> [!TIP]\n[sheet id="code" chart="c"]\n</details>';
    const markdown = `Before\n\n~~~markdown\n${code}\n~~~\n\nAfter\n[sheet id="real" chart="c"]`;
    const doc = parseMarkdown(markdown);
    expect(doc.childCount).toBe(4);
    expect(doc.child(1).type.name).toBe("codeBlock");
    expect(doc.child(1).textContent).toBe(code);
    expect(doc.child(3).type.name).toBe("sheetEmbed");
    expect(doc.child(3).attrs.sheet).toBe("real");
    expect(indexed.parse(markdown)).toEqual(unindexed.parse(markdown));
  });

  it("leaves escaped openings as text before a real interruption", () => {
    const markdown =
      'Before\n\\[sheet id="text" chart="c"]\n\\<details>\n\\> [!NOTE]\n[sheet id="real" chart="c"]\n\nAfter';
    expect(indexed.parse(markdown)).toEqual(unindexed.parse(markdown));
    const doc = parseMarkdown(markdown);
    doc.check();
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe("paragraph");
    expect(doc.child(0).textContent).toContain('[sheet id="text" chart="c"]');
    expect(doc.child(0).textContent).toContain("<details>");
    expect(doc.child(0).textContent).toContain("> [!NOTE]");
    expect(doc.child(1).type.name).toBe("sheetEmbed");
    expect(doc.child(1).attrs.sheet).toBe("real");
  });

  it("does not keep discovery indexes after a call or failed nested tokenization", () => {
    const marked = isolatedMarked();
    const manager = new MarkdownManager({ extensions: documentExtensions, marked });
    manager.instance.use({
      extensions: [
        {
          name: "fixtureFailure",
          level: "block",
          tokenizer(src) {
            if (src.startsWith("fail")) throw new Error("nested tokenizer failure");
            return undefined;
          },
        },
      ],
    });
    const lexer = new DocumentLexer(marked.defaults);
    lexer.blockTokens('Before\n[sheet id="first" chart="c"]');
    expect(Reflect.get(lexer, "starts")).toBeNull();
    expect(() =>
      lexer.blockTokens("Before\n\n<details>\n<summary>S</summary>\n\nBody\n\nfail\n\n</details>"),
    ).toThrow("nested tokenizer failure");
    expect(Reflect.get(lexer, "starts")).toBeNull();
    const recovered = 'Before\n[sheet id="other" chart="c"]';
    expect(lexer.blockTokens(recovered)).toEqual(
      new DocumentLexer(marked.defaults).blockTokens(recovered),
    );
  });
});
