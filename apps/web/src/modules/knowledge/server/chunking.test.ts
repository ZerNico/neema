import {
  PDF_EXTRACTION_REVISION,
  pdfFingerprint,
} from "~/modules/attachments/server/document-parser.ts";
import { describe, expect, it } from "vitest";
import {
  CHUNKING,
  CHUNKER_REVISION,
  pipelineFingerprint,
  chunkDocument,
  estimateTokens,
  splitBlocks,
} from "./chunking.ts";

const maxChars = CHUNKING.maxTokens * CHUNKING.charsPerToken;
const targetChars = CHUNKING.targetTokens * CHUNKING.charsPerToken;
const overlapChars = CHUNKING.overlapTokens * CHUNKING.charsPerToken;

// Unique, equal-sized sentences make missing/repeated text and wrong offsets
// observable; repeated filler alone can accidentally validate the wrong slice.
const sentences = (count: number, prefix = "Sentence") =>
  Array.from({ length: count }, (_, index) =>
    `${prefix} ${String(index).padStart(3, "0")}: a distinct observation`
      .padEnd(198, " detail")
      .slice(0, 198)
      .concat(". "),
  );

const verifyChunks = (text: string) => {
  const chunks = chunkDocument(text);
  expect(chunkDocument(text)).toEqual(chunks);
  const covered = new Uint8Array(text.length);
  for (const [index, chunk] of chunks.entries()) {
    expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
    expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
    expect(chunk.endOffset).toBeLessThanOrEqual(text.length);
    expect(chunk.content).toBe(text.slice(chunk.startOffset, chunk.endOffset));
    expect(chunk.content.trim()).not.toBe("");
    expect(chunk.tokens).toBe(estimateTokens(chunk.content));
    expect(chunk.tokens).toBeLessThanOrEqual(CHUNKING.maxTokens);
    covered.fill(1, chunk.startOffset, chunk.endOffset);
    if (index > 0) {
      const previous = chunks[index - 1]!;
      expect(chunk.startOffset).toBeGreaterThan(previous.startOffset);
      expect(chunk.endOffset).toBeGreaterThan(previous.endOffset);
      const overlap = previous.endOffset - chunk.startOffset;
      expect(overlap).toBeLessThanOrEqual(overlapChars);
      if (overlap > 0) {
        expect(chunk.content.slice(0, overlap)).toBe(previous.content.slice(-overlap));
        expect(chunk.page).toBe(previous.page);
        expect(chunk.headingPath).toBe(previous.headingPath);
      }
    }
  }
  for (let index = 0; index < text.length; index++) {
    if (/\S/u.test(text[index]!)) {
      expect(covered[index], `uncovered source character at ${index}`).toBe(1);
    }
  }
  return chunks;
};

describe("splitBlocks", () => {
  it("preserves headings and markers while tracking their breadcrumb and page", () => {
    const text =
      "# Vendor Agreement\n\nPreamble text.\n\n## Termination\n\nEither party may terminate.\n\n[page 2]\nNotice must be written.";
    expect(splitBlocks(text).map((block) => [block.headingPath, block.page, block.text])).toEqual([
      ["Vendor Agreement", null, "# Vendor Agreement"],
      ["Vendor Agreement", null, "Preamble text."],
      ["Vendor Agreement › Termination", null, "## Termination"],
      ["Vendor Agreement › Termination", null, "Either party may terminate."],
      ["Vendor Agreement › Termination", 2, "[page 2]"],
      ["Vendor Agreement › Termination", 2, "Notice must be written."],
    ]);
  });

  it("uses original offsets with CRLF, indentation, setext headings and standalone rules", () => {
    const text = " \r\nTitle\r\n===\r\n\r\n  First body.\r\nsecond line.\r\n\r\n---\r\n\r\n## End";
    const blocks = splitBlocks(text);
    for (const block of blocks) {
      expect(block.text).toBe(text.slice(block.start, block.end));
    }
    expect(blocks.map((block) => block.text)).toEqual([
      "Title\r\n===",
      "First body.\r\nsecond line.",
      "---",
      "## End",
    ]);
    expect(blocks.at(-1)!.headingPath).toBe("Title › End");
    verifyChunks(text);
  });

  it("keeps consecutive list items in one block", () => {
    const blocks = splitBlocks("## Duties\n\n- deliver\n- invoice\n- support\n\nSeparate.");
    expect(blocks[1]!.text).toBe("- deliver\n- invoice\n- support");
    expect(blocks).toHaveLength(3);
  });
});

describe("chunkDocument", () => {
  it("keeps a short same-page document whole across headings without normalizing whitespace", () => {
    const text = "# Note\r\n\r\nA short thought.\r\n \t\r\n## Details\r\nA second line.";
    const chunks = verifyChunks(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      content: text,
      startOffset: 0,
      endOffset: text.length,
      headingPath: "Note",
    });
  });

  it.each([
    "# Title",
    "# Title\n## Child\n### Leaf",
    "Title\n===\n\nSubtitle\n---",
    "---",
    "[page 1]",
  ])("preserves heading/marker-only documents: %s", (text) => {
    expect(verifyChunks(text).map((chunk) => chunk.content)).toEqual([text]);
  });

  it("never packs different pages or unpaged preambles into one-page attribution", () => {
    const text =
      "Preamble.\n\n[page 1]\n# One\nFirst page.\n\n[page 2]\nSecond page.\n[page 2]\nRepeated label.";
    const chunks = verifyChunks(text);
    expect(chunks.map((chunk) => chunk.page)).toEqual([null, 1, 2, 2]);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "Preamble.",
      "[page 1]\n# One\nFirst page.",
      "[page 2]\nSecond page.",
      "[page 2]\nRepeated label.",
    ]);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index]!.startOffset).toBeGreaterThanOrEqual(chunks[index - 1]!.endOffset);
    }
  });

  it("respects section boundaries in large documents and preserves a final heading", () => {
    const first = `# Alpha\n\n${sentences(15, "Alpha").join("")}`;
    const second = `## Beta\n\n${sentences(15, "Beta").join("")}`;
    const chunks = verifyChunks(`${first}\n\n${second}\n\n# Final heading`);
    expect(chunks.map((chunk) => chunk.headingPath)).toEqual([
      "Alpha",
      "Alpha › Beta",
      "Final heading",
    ]);
    expect(chunks[0]!.content).toBe(first.trimEnd());
    expect(chunks[1]!.content).toBe(second.trimEnd());
    expect(chunks[2]!.content).toBe("# Final heading");
  });

  it.each(["Sentence", "lowercase", "条項"])(
    "splits unique %s sentences at natural boundaries with exact overlap",
    (prefix) => {
      const parts = sentences(60, prefix);
      const text = parts.join("");
      const chunks = verifyChunks(text);
      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks[0]!.endOffset).toBe(targetChars);
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.startOffset % 200).toBe(0);
        expect(chunk.content.trimEnd().endsWith(".")).toBe(true);
        if (index > 0) {
          expect(chunk.startOffset).toBeLessThan(chunks[index - 1]!.endOffset);
        }
      }
    },
  );

  it("prefers paragraph breaks over nearby sentence breaks", () => {
    const paragraphs = Array.from({ length: 8 }, (_, index) =>
      sentences(6, `Paragraph${index}`).join("").trimEnd(),
    );
    const text = paragraphs.join("\r\n\r\n");
    const chunks = verifyChunks(text);
    const boundary = paragraphs[0]!.length + paragraphs[1]!.length + 8;
    expect(chunks[0]!.endOffset).toBe(boundary);
    expect(chunks[0]!.content.endsWith("\r\n\r\n")).toBe(true);
  });

  it("uses line boundaries for large lists with no sentence punctuation", () => {
    const lines = Array.from(
      { length: 100 },
      (_, index) => `- Item ${index}: ${"specific detail ".repeat(8)}`,
    );
    const text = lines.join("\n");
    const chunks = verifyChunks(text);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.content.endsWith("\n")).toBe(true);
  });

  it("backs off to word boundaries when prose has no sentence or line breaks", () => {
    const text = Array.from({ length: 2_000 }, (_, index) => `word${index}`).join("\t");
    const chunks = verifyChunks(text);
    for (const chunk of chunks) {
      expect(chunk.content).toMatch(/^word\d/);
      expect(chunk.content.trimEnd()).toMatch(/word\d+$/);
      if (chunk.endOffset < text.length) expect(text[chunk.endOffset - 1]).toBe("\t");
    }
  });

  it.each([maxChars - 1, maxChars, maxChars + 1, maxChars * 3])(
    "honors the estimate ceiling for %i unbroken characters",
    (length) => {
      const text = Array.from({ length }, (_, index) =>
        String.fromCharCode(65 + (index % 26)),
      ).join("");
      const chunks = verifyChunks(text);
      expect(chunks.length === 1).toBe(length <= maxChars);
      if (length > maxChars) {
        expect(chunks[0]!.endOffset).toBe(targetChars);
        expect(chunks[1]!.startOffset).toBe(targetChars - overlapChars);
      }
    },
  );

  it("never concatenates a duplicated overlap into a short tail", () => {
    const text = sentences(29).join("");
    const chunks = verifyChunks(text);
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => [chunk.startOffset, chunk.endOffset])).toEqual([
      [0, 2800],
      [2600, text.trimEnd().length],
    ]);
    expect(chunks[1]!.content.match(/Sentence 013:/g)).toHaveLength(1);
  });

  it("does not cut surrogate pairs even during hard splitting", () => {
    const text = `a${"😀".repeat(6_000)}`;
    const chunks = verifyChunks(text);
    for (const chunk of chunks) {
      // In Unicode mode valid surrogate pairs match as one code point; this
      // range therefore detects only lone surrogate code units.
      expect(chunk.content).not.toMatch(/[\uD800-\uDFFF]/u);
    }
  });

  it("is deterministic across a mixture of pages, headings and oversized sections", () => {
    const text = `# Intro\nShort.\n[page 1]\nTitle\n===\n${sentences(50).join("")}\n\n## Last\nEnd.\n[page 2]\n# Heading only`;
    const chunks = verifyChunks(text);
    expect(
      chunks.find((chunk) => chunk.page === 1)!.content.startsWith("[page 1]\nTitle\n==="),
    ).toBe(true);
    expect(chunks.at(-1)!.page).toBe(2);
  });

  it("returns nothing for whitespace and explicitly uses a chars/4 estimate", () => {
    expect(verifyChunks(" \t\r\n\n ")).toEqual([]);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("😀😀")).toBe(1);
  });
});

it("versions PDF extraction independently from authored notes and decoded text", () => {
  // The parser's fingerprint carries the PDF revision and scan engine itself.
  expect(pipelineFingerprint(pdfFingerprint("off"))).toBe(
    `pdf-${PDF_EXTRACTION_REVISION}+scan:off:chunker-${CHUNKER_REVISION}`,
  );
  expect(pipelineFingerprint(null)).toBe(`none:chunker-${CHUNKER_REVISION}`);
  expect(pipelineFingerprint("utf8")).toBe(`utf8:chunker-${CHUNKER_REVISION}`);
});
