import { deflateSync } from "node:zlib";
import {
  commentsPart,
  externalHyperlinks,
  footnotesPart,
  images,
  openDocx,
  outline,
  stylesPart,
  title,
  validate,
} from "@office-kit/docx";
import { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { documentToWord } from "~/modules/word/server/document-export.ts";
import { wordToDocument } from "~/modules/word/server/document-import.ts";
import type { WordRuntime } from "~/modules/word/server/runtime.ts";
import { documentSchema, parseMarkdown, toMarkdown } from "../editor/markdown.ts";
import { DOCUMENT_LIMITS, type DocumentComment } from "../schema.ts";
import { applyChange } from "@chat/sheet/model/apply";
import { calculateSheet } from "@chat/sheet/model/calc";
import { parseFormula } from "@chat/sheet/model/formula";
import { emptyDoc } from "@chat/sheet/model";
import { embeddedSheetIds, exportImages, wordExportInput } from "./word-export.ts";
import { placeImported, readWordDocument } from "./word-import.ts";

/** A real PNG of `width` by `height` grey pixels, so Word and the importer both read its size. */
const png = (width: number, height: number) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 0, 0, 0, 0], 8);
  const rows = new Uint8Array((width + 1) * height).fill(128);
  for (let row = 0; row < height; row++) rows[row * (width + 1)] = 0;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(rows))),
    chunk("IEND", new Uint8Array()),
  ];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
};

const SOURCE = `# One

## Two

### Three

#### Four

##### Five

###### Six

Text with **bold**, *italic*, <u>under</u>, ~~gone~~, \`code\`, <mark>lit</mark>, a [site](https://example.test/page) and [mail](mailto:a@example.test).

- bullet one
  - nested bullet
- bullet two

3. third
4. fourth
   1. inner

- [ ] open task
- [x] done task

> A quote

\`\`\`ts
const a = 1;
  indented();
\`\`\`

| Name | Value |
| --- | --- |
| rent | **900** |

---

$$
E = mc^2
$$

Inline $x^2$ math, on [date value="2026-10-09"] with [@ id="u1" label="Ada"].

> [!WARNING]
> Mind the gap.

<details>
<summary>More</summary>

Hidden text.

</details>

A claim.^[The source of it.]

![Logo](/api/documents/doc-1/images/att-1) and ![Remote](https://example.test/r.png)

Please review this sentence.`;

/** The source with a comment thread on "review this", as an editor marks it. */
const sourceTree = () => {
  const doc = parseMarkdown(SOURCE);
  let from = -1;
  doc.descendants((node, position) => {
    const at = node.isText ? (node.text ?? "").indexOf("review this") : -1;
    if (at >= 0) from = position + at;
    return from < 0;
  });
  return new Transform(doc).addMark(
    from,
    from + "review this".length,
    documentSchema.marks.comment!.create({ thread: "thread-1" }),
  ).doc;
};

const comment = (overrides: Partial<DocumentComment>): DocumentComment => ({
  id: "thread-1",
  threadId: "thread-1",
  author: { id: "u1", name: "Ada" },
  byAssistant: false,
  fromFile: null,
  body: "Is this right?",
  createdAt: "2026-10-01T09:00:00.000Z",
  resolvedAt: null,
  quote: "review this",
  toAssistant: false,
  answered: false,
  ...overrides,
});
const COMMENTS = [
  comment({}),
  comment({ id: "reply-1", author: null, byAssistant: true, body: "Yes.", quote: null }),
  // A resolved thread is not carried into the file.
  comment({ id: "thread-2", threadId: "thread-2", resolvedAt: "2026-10-02T09:00:00.000Z" }),
];

const LOGO = png(40, 20);
const exported = async () => {
  const doc = sourceTree();
  const pictures = await Effect.runPromise(
    exportImages("doc-1", doc, (id) => Effect.succeed(id === "att-1" ? LOGO : null)),
  );
  return documentToWord(wordExportInput("Launch plan", doc, COMMENTS, pictures));
};

const BOUNDS = {
  blocks: DOCUMENT_LIMITS.blocks,
  chars: DOCUMENT_LIMITS.chars,
  imageBytes: 1024 * 1024,
  comments: DOCUMENT_LIMITS.comments,
  comment: DOCUMENT_LIMITS.comment,
  quote: DOCUMENT_LIMITS.quote,
};
/** The importer in process; the worker boundary is covered by the runtime test. */
const inProcess: WordRuntime = {
  run: async (request) => {
    if (request.kind !== "importDocument") throw new Error(`Unexpected Word work: ${request.kind}`);
    return wordToDocument(request.bytes, request.bounds) as never;
  },
  close: async () => {},
};

describe("a document as a Word file", () => {
  it("writes headings in the built-in styles, lists, tables, footnotes, pictures, links and comments", async () => {
    const word = openDocx(await exported());
    expect(validate(word).filter((issue) => issue.level === "error")).toEqual([]);
    expect(title(word)).toBe("Launch plan");
    expect(outline(word).map((each) => [each.level, each.text])).toEqual([
      [1, "One"],
      [2, "Two"],
      [3, "Three"],
      [4, "Four"],
      [5, "Five"],
      [6, "Six"],
    ]);
    // A table of contents follows outline levels, which the heading styles carry.
    const heading2 = stylesPart(word)!.styles.find((style) =>
      style.attrs.some((attr) => attr.name.local === "styleId" && attr.value === "Heading2"),
    )!;
    expect(JSON.stringify(heading2)).toContain('"local":"outlineLvl"');
    expect(footnotesPart(word)!.footnotes.length).toBeGreaterThanOrEqual(1);
    expect(images(word).map((each) => each.data)).toEqual([LOGO]);
    expect(externalHyperlinks(word).map((each) => each.target)).toEqual([
      "https://example.test/page",
      "mailto:a@example.test",
      "https://example.test/r.png",
    ]);
    const threads = commentsPart(word)!.comments;
    expect(threads).toHaveLength(1);
    expect(JSON.stringify(threads[0])).toContain("Is this right?");
    expect(JSON.stringify(threads[0])).toContain("Assistant: Yes.");
  });

  it("reads back as the same document, but for what Word has no place for", async () => {
    const stored: Array<{ mediaType: string; bytes: Uint8Array }> = [];
    const read = await Effect.runPromise(
      readWordDocument(
        { name: "Launch plan.docx", mediaType: "", bytes: await exported() },
        inProcess,
        "someone",
        (image) =>
          Effect.sync(() => {
            stored.push(image);
            return `att-${stored.length}`;
          }),
      ),
    );
    expect(read.title).toBe("Launch plan");
    expect(read.dropped).toEqual([]);
    expect(stored).toEqual([{ bytes: LOGO, mediaType: "image/png", name: "Launch plan 1.png" }]);
    expect(read.imported.images).toEqual(["att-1"]);
    expect(read.imported.threads).toEqual([
      {
        ref: expect.any(String),
        comments: [{ author: "Ada", text: "Is this right?\nAssistant: Yes." }],
        quote: "review this",
        resolved: false,
      },
    ]);
    const threadIds = new Map([[read.imported.threads[0]!.ref, "thread-new"]]);
    const doc = Node.fromJSON(documentSchema, placeImported(read.imported, "doc-2", threadIds));
    doc.check();
    expect(toMarkdown(doc)).toBe(
      [
        "# One",
        "## Two",
        "### Three",
        "#### Four",
        "##### Five",
        "###### Six",
        "Text with **bold**, *italic*, <u>under</u>, ~~gone~~, `code`, <mark>lit</mark>, a [site](https://example.test/page) and [mail](mailto:a@example.test).",
        "- bullet one\n  - nested bullet\n- bullet two",
        "3. third\n4. fourth\n   1. inner",
        "- [ ] open task\n- [x] done task",
        "> A quote",
        "```\nconst a = 1;\n  indented();\n```",
        "| Name | Value   |\n| ---- | ------- |\n| rent | **900** |",
        "---",
        "$$\nE = mc^2\n$$",
        "Inline $x^2$ math, on 2026-10-09 with @Ada.",
        "> [!WARNING]\n> Mind the gap.",
        "**More**",
        "Hidden text.",
        "A claim.[^1]",
        "![Logo](/api/documents/doc-2/images/att-1) and [Remote](https://example.test/r.png)",
        "Please review this sentence.",
        "[^1]: The source of it.",
      ].join("\n\n"),
    );
    // The comment is on the words it was on.
    let commented = "";
    doc.descendants((node) => {
      if (node.marks.some((mark) => mark.attrs.thread === "thread-new")) commented += node.text;
      return true;
    });
    expect(commented).toBe("review this");
    // The table's first row is still its header.
    let header = false;
    doc.descendants((node) => {
      if (node.type.name === "tableHeader") header = true;
      return true;
    });
    expect(header).toBe(true);
  });

  it("refuses a file past the document's limits instead of keeping part of it", async () => {
    const long = parseMarkdown(
      Array.from({ length: 60 }, (_, index) => `Paragraph ${index}`).join("\n\n"),
    );
    const bytes = documentToWord(wordExportInput("Long", long, [], {}));
    expect(() => wordToDocument(bytes, { ...BOUNDS, blocks: 50 })).toThrow(
      /too long for a document: it has 60 paragraphs, list items and tables, and a document holds 50/,
    );
    expect(() => wordToDocument(new TextEncoder().encode("not a zip"), BOUNDS)).toThrow(
      /not a Word file the app can open/,
    );
  });

  it("writes a sheet embed's range as a table of what its cells show now", async () => {
    let sheet = emptyDoc("Data");
    const formula = parseFormula("B1*2", { doc: sheet, sheet: "s1" });
    if (!("formula" in formula)) throw new Error("needs growth");
    sheet = applyChange(
      sheet,
      {
        clientId: "seed",
        seq: 1,
        ops: [
          {
            op: "set",
            sh: "s1",
            cells: [
              { r: "s1.r1", c: "s1.c1", v: "Rent" },
              { r: "s1.r1", c: "s1.c2", v: 900 },
              { r: "s1.r2", c: "s1.c1", v: "Twice" },
              { r: "s1.r2", c: "s1.c2", f: formula.formula },
            ],
          },
          {
            op: "format",
            sh: "s1",
            area: { r1: "s1.r1", r2: "s1.r1", c1: "s1.c1", c2: "s1.c1" },
            patch: { bold: true },
          },
        ],
      },
      1,
    ).doc;
    const doc = parseMarkdown(
      [
        "Costs:",
        '[sheet id="sheet-1" range="Data!A1:B2"]',
        '[sheet id="sheet-1" chart="c1"]',
        '[sheet id="private" range="Data!A1"]',
      ].join("\n\n"),
    );
    // The route reads only sheets the reader may read; `private` is not among them.
    expect(embeddedSheetIds(doc)).toEqual(["sheet-1", "private"]);
    const sheets = new Map([
      [
        "sheet-1",
        {
          title: "Budget",
          doc: sheet,
          values: calculateSheet(sheet, { revision: 1, epoch: 0, now: 45_000, seed: 1 }),
        },
      ],
    ]);
    const read = await Effect.runPromise(
      readWordDocument(
        {
          name: "Costs.docx",
          mediaType: "",
          bytes: documentToWord(wordExportInput("Costs", doc, [], {}, sheets)),
        },
        inProcess,
        "someone",
        () => Effect.succeed("unused"),
      ),
    );
    const back = Node.fromJSON(documentSchema, placeImported(read.imported, "doc-3", new Map()));
    expect(toMarkdown(back)).toBe(
      [
        "Costs:",
        "*Budget · Data!A1:B2*",
        "| **Rent** | 900  |\n| -------- | ---- |\n| Twice    | 1800 |",
        "*Budget · chart*",
        "*Sheet range Data!A1*",
      ].join("\n\n"),
    );
  });
});

describe("a Word file from awkward documents", () => {
  const docOf = (content: object[]) => Node.fromJSON(documentSchema, { type: "doc", content });
  const paragraph = (text: string, extra: object[] = []) => ({
    type: "paragraph",
    content: [{ type: "text", text }, ...extra],
  });
  const readBack = (bytes: Uint8Array, bounds = BOUNDS) =>
    Node.fromJSON(documentSchema, wordToDocument(bytes, bounds).tree);

  it("leaves out characters XML forbids, which Word would refuse to open", () => {
    const doc = docOf([paragraph("a\u000Bb\u000C\u0001c￾d\uD800e")]);
    const bytes = documentToWord(wordExportInput("T\u0001itle", doc, [], {}));
    expect(validate(openDocx(bytes)).filter((issue) => issue.level === "error")).toEqual([]);
    expect(title(openDocx(bytes))).toBe("Title");
    expect(readBack(bytes).textContent).toBe("abcde");
  });

  it("keeps a picture's shape when it is narrowed to the page", () => {
    const doc = docOf([
      paragraph("A ", [
        { type: "image", attrs: { src: "pic", alt: "Wide", width: 1208, height: 400 } },
      ]),
    ]);
    const xml = JSON.stringify(
      openDocx(documentToWord(wordExportInput("Wide", doc, [], { pic: LOGO }))).document,
    );
    const extent =
      /"local":"extent".*?"local":"cx".*?"value":"(\d+)".*?"local":"cy".*?"value":"(\d+)"/.exec(
        xml,
      );
    // Asked for 1208 by 400 pixels, halved to the page’s 604 pixels of width.
    expect([Number(extent?.[1]), Number(extent?.[2])]).toEqual([604 * 9_525, 200 * 9_525]);
  });
});
