import { PDF_EXTRACTION_REVISION } from "~/modules/attachments/server/document-parser.ts";
/**
 * Deterministic source ranges, never reconstructed text. Small page spans stay
 * whole; larger ones split by heading, then paragraph/sentence/line boundaries,
 * then whitespace or hard character cuts. Only split sections overlap.
 * Boundaries belong to immutable versions (see CHUNKER_REVISION).
 */

/** Bumped when boundaries change; persisted on the immutable content version. */
export const CHUNKER_REVISION = 2;

/**
 * Identity of the extraction pipeline that produced a version's text and chunk
 * boundaries. Recorded on publication so an owner can tell which documents
 * predate a parser or chunker change. The content is immutable, so improving
 * the pipeline means building a *new* version, never rewriting an old one.
 *
 * Notes carry their own text, so only the chunker is part of their identity.
 */
export const pipelineFingerprint = (parsedWith: string | null): string =>
  `${parsedWith ?? "none"}${parsedWith && parsedWith !== "utf8" ? `:pdf-${PDF_EXTRACTION_REVISION}` : ""}:chunker-${CHUNKER_REVISION}`;

export const CHUNKING = {
  targetTokens: 700,
  /** A ceiling on the estimate, NOT on a provider's actual tokenizer. */
  maxTokens: 1_000,
  overlapTokens: 90,
  /** UTF-16 code units per estimated token, not a true tokenizer. */
  charsPerToken: 4,
} as const;

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHUNKING.charsPerToken);

export interface SourceBlock {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly page: number | null;
  readonly headingPath: string;
}

export interface DocumentChunk {
  readonly content: string;
  readonly headingPath: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly page: number | null;
  readonly tokens: number;
}

/** `[page 12]` lines are how the PDF parser marks page starts. */
const PAGE_MARKER = /^\[page (\d+)\]$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
const SETEXT_UNDERLINE = /^(=|-){3,}\s*$/;

const headingPathOf = (levels: ReadonlyArray<string>): string =>
  levels.filter((level) => level.length > 0).join(" › ");

/** Every non-whitespace source character belongs to a block, including markers. */
export function splitBlocks(text: string): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  const headings: string[] = [];
  let page: number | null = null;
  let bufferStart = 0;

  const flush = (end: number) => {
    const source = text.slice(bufferStart, end);
    const trimmed = source.trim();
    if (trimmed.length > 0) {
      const start = bufferStart + source.length - source.trimStart().length;
      blocks.push({
        text: text.slice(start, start + trimmed.length),
        start,
        end: start + trimmed.length,
        page,
        headingPath: headingPathOf(headings),
      });
    }
    bufferStart = end;
  };

  const setHeading = (level: number, title: string) => {
    headings.length = Math.min(headings.length, level - 1);
    while (headings.length < level - 1) headings.push("");
    headings[level - 1] = title;
  };

  const lines = text.split("\n");
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const lineStart = offset;
    offset = Math.min(text.length, offset + line.length + 1);
    const pageMatch = PAGE_MARKER.exec(line.trim());
    if (pageMatch) {
      flush(lineStart);
      page = Number(pageMatch[1]);
      // A standalone marker also gives the packer an explicit page boundary,
      // even if successive extracted pages happen to use the same page number.
      flush(offset);
      continue;
    }

    const heading = HEADING.exec(line);
    const next = lines[index + 1];
    if (heading) {
      flush(lineStart);
      setHeading(heading[1]!.length, heading[2]!.trim());
    } else if (line.trim().length > 0 && next !== undefined && SETEXT_UNDERLINE.test(next)) {
      flush(lineStart);
      setHeading(next.startsWith("=") ? 1 : 2, line.trim());
      offset = Math.min(text.length, offset + next.length + 1);
      index++;
    } else if (line.trim().length === 0) {
      flush(offset);
    }
  }
  flush(text.length);
  return blocks;
}

const TARGET_CHARS = CHUNKING.targetTokens * CHUNKING.charsPerToken;
const MAX_CHARS = CHUNKING.maxTokens * CHUNKING.charsPerToken;
const OVERLAP_CHARS = CHUNKING.overlapTokens * CHUNKING.charsPerToken;

/** Prefer structure near the target; a short boundary must not make tiny chunks. */
const naturalEnd = (text: string, start: number, end: number): number => {
  const window = text.slice(start, Math.min(end, start + MAX_CHARS));
  for (const pattern of [/\r?\n[\t ]*\r?\n\s*/gu, /[.!?…]["')\]]?\s+/gu, /\r?\n\s*/gu, /\s+/gu]) {
    let before = 0;
    let after = 0;
    for (const match of window.matchAll(pattern)) {
      const boundary = match.index + match[0].length;
      if (boundary < TARGET_CHARS / 2) continue;
      if (boundary <= TARGET_CHARS) before = boundary;
      else if (!after) after = boundary;
    }
    if (before || after) return start + (before || after);
  }
  // Avoid cutting a UTF-16 surrogate pair in otherwise unbroken text.
  const cut = start + TARGET_CHARS;
  return /[\uDC00-\uDFFF]/u.test(text[cut]!) ? cut - 1 : cut;
};

/** Overlap is a source suffix of at most 90 estimated tokens, not a new prefix. */
const overlapStart = (text: string, start: number, end: number): number => {
  const earliest = Math.max(start + 1, end - OVERLAP_CHARS);
  const tail = text.slice(earliest, end);
  for (const pattern of [/[.!?…]["')\]]?\s+|\n\s*/gu, /\s+/gu]) {
    for (const match of tail.matchAll(pattern)) {
      const boundary = earliest + match.index + match[0].length;
      if (boundary < end) return boundary;
    }
  }
  return /[\uDC00-\uDFFF]/u.test(text[earliest]!) ? earliest + 1 : earliest;
};

export function chunkDocument(text: string): DocumentChunk[] {
  const blocks = splitBlocks(text);
  const chunks: DocumentChunk[] = [];

  const emit = (start: number, end: number, block: SourceBlock) => {
    const content = text.slice(start, end);
    chunks.push({
      content,
      startOffset: start,
      endOffset: end,
      page: block.page,
      headingPath: block.headingPath,
      tokens: estimateTokens(content),
    });
  };

  const splitRange = (first: SourceBlock, last: SourceBlock) => {
    let start = first.start;
    while (last.end - start > MAX_CHARS) {
      const end = naturalEnd(text, start, last.end);
      emit(start, end, first);
      start = overlapStart(text, start, end);
    }
    emit(start, last.end, first);
  };

  for (let pageStart = 0; pageStart < blocks.length;) {
    let pageEnd = pageStart + 1;
    while (
      pageEnd < blocks.length &&
      blocks[pageEnd]!.page === blocks[pageStart]!.page &&
      !PAGE_MARKER.test(blocks[pageEnd]!.text)
    ) {
      pageEnd++;
    }
    const first = blocks[pageStart]!;
    const last = blocks[pageEnd - 1]!;
    if (last.end - first.start <= MAX_CHARS) {
      // Short documents (or individual pages) retain all headings together.
      const metadata =
        blocks.slice(pageStart, pageEnd).find((block) => !PAGE_MARKER.test(block.text)) ?? first;
      emit(first.start, last.end, metadata);
    } else {
      for (let sectionStart = pageStart; sectionStart < pageEnd;) {
        let sectionEnd = sectionStart + 1;
        // Attach a leading page marker to the first section, not a tiny chunk.
        const metadata =
          PAGE_MARKER.test(blocks[sectionStart]!.text) && sectionEnd < pageEnd
            ? blocks[sectionEnd]!
            : blocks[sectionStart]!;
        while (sectionEnd < pageEnd && blocks[sectionEnd]!.headingPath === metadata.headingPath) {
          sectionEnd++;
        }
        splitRange({ ...metadata, start: blocks[sectionStart]!.start }, blocks[sectionEnd - 1]!);
        sectionStart = sectionEnd;
      }
    }
    pageStart = pageEnd;
  }
  return chunks;
}
