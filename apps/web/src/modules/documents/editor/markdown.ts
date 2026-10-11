import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { isolatedMarked } from "./isolated-marked.ts";
import { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { adoptIds } from "./block-ids.ts";
import { footnoteDefinitions, numberFootnotes } from "./blocks.ts";
import { plainChips } from "./chips.ts";
import { plainSheetEmbeds } from "./sheet-embed.ts";
import { documentExtensions, fenceFor } from "./extensions.ts";
import { escapeMathDollars, markMathBeforeDigits } from "./math.ts";

export const documentSchema = getSchema(documentExtensions);
const manager = new MarkdownManager({ extensions: documentExtensions, marked: isolatedMarked() });

type EncodeText = (text: string, node: unknown, parent: unknown) => string;
const upstreamEncode = Reflect.get(manager, "encodeTextForMarkdown") as EncodeText;
const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
/**
 * Upstream writes every `&`, `<` and `>` in text as an HTML entity, so the
 * Markdown read "LCP &lt; 2.5 s" wherever it left the editor, and the model's
 * XML view escaped it a second time. A backslash keeps them literal instead,
 * and only where one would start a tag or an entity.
 */
Reflect.set(
  manager,
  "encodeTextForMarkdown",
  function (this: unknown, ...args: Parameters<EncodeText>) {
    const marks = (args[1] as { marks?: { type: string }[] } | null)?.marks ?? [];
    const parent = (args[2] as { type?: string } | null)?.type;
    const code = parent === "codeBlock" || marks.some((mark) => mark.type === "code");
    const encoded = upstreamEncode.apply(this, args);
    // Code is verbatim; anywhere else a dollar must not open math on the next read.
    return (code ? encoded : escapeMathDollars(encoded)).replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity, offset: number, all: string) => {
        const character = ENTITIES[entity]!;
        const after = all.slice(offset + entity.length);
        if (character === "<" && /^[A-Za-z/!?]/.test(after)) return "\\<";
        if (character === "&" && /^#?\w+;/.test(after)) return "\\&";
        if (character === ">" && offset === 0) return "\\>";
        return character;
      },
    );
  },
);

/**
 * Inline code is written verbatim between the mark's one backtick each side,
 * so code holding a backtick would close early. The rest of a longer fence,
 * and a space where the code starts or ends with a backtick, go inside the text.
 */
const fenceInlineCode = (node: JSONContent): JSONContent => {
  const text = node.text;
  if (text !== undefined) {
    if (!node.marks?.some((mark) => mark.type === "code")) return node;
    const extra = fenceFor(text, 1).slice(1);
    const pad = /^`|`$/.test(text) ? " " : "";
    return extra || pad ? { ...node, text: `${extra}${pad}${text}${pad}${extra}` } : node;
  }
  return node.content ? { ...node, content: node.content.map(fenceInlineCode) } : node;
};

/**
 * An empty paragraph holds no Markdown, and the editor keeps one after the
 * last block to type into; written out, it would change a document just by
 * someone opening it.
 */
const withoutEmptyParagraphs = (doc: JSONContent): JSONContent =>
  doc.content
    ? {
        ...doc,
        content: doc.content.filter((block) => block.type !== "paragraph" || block.content?.length),
      }
    : doc;

/** A planned section has no text yet; left in, it would write an empty block. */
const withoutPending = (node: JSONContent): JSONContent =>
  node.content
    ? {
        ...node,
        content: node.content.filter((child) => child.type !== "pending").map(withoutPending),
      }
    : node;

const serialize = (json: JSONContent) =>
  manager.serialize(
    markMathBeforeDigits(fenceInlineCode(withoutEmptyParagraphs(withoutPending(json)))),
  );

/**
 * The Markdown the model reads and writes: chips and sheet embeds as
 * shortcodes (`[date value="…"]`, `[@ id="…" label="…"]`, `[sheet id="…" range="…"]`),
 * so it can tell them from text.
 */
export const toModelMarkdown = (node: Node) => serialize(node.toJSON());

/**
 * The Markdown a tree reads as for people, for Copy and export: footnotes as
 * numbered references with their definitions at the end, as GitHub draws them,
 * and sheet embeds as a line naming what they showed.
 */
export const toMarkdown = (node: Node) => {
  const { json, notes } = numberFootnotes(
    plainSheetEmbeds(plainChips(node)).toJSON() as JSONContent,
  );
  const markdown = serialize(json);
  if (!notes.length) return markdown;
  const definitions = notes.map((note, index) => `[^${index + 1}]: ${note}`).join("\n");
  return markdown ? `${markdown}\n\n${definitions}` : definitions;
};

/** A footnote's definition line: its label, then its note. */
const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]+(.*)$/;
/** A fenced code block's opening or closing line. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * The Markdown with its footnotes' definitions taken out into
 * `footnoteDefinitions`, lines indented under one continuing it. A line in
 * fenced code is code, never a definition.
 */
const takeDefinitions = (markdown: string) => {
  const kept: string[] = [];
  const lines = markdown.split("\n");
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = FENCE.exec(line)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker!;
      else if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      kept.push(line);
      continue;
    }
    const definition = DEFINITION.exec(line);
    if (!definition) {
      kept.push(line);
      continue;
    }
    let note = definition[2]!;
    while (/^(?: {2,}|\t)\S/.test(lines[index + 1] ?? "")) note += ` ${lines[++index]!.trim()}`;
    footnoteDefinitions.set(definition[1]!, note.trim());
  }
  // Where definitions stood, blank lines would read as empty paragraphs.
  return kept.length === lines.length
    ? markdown
    : kept
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();
};

const INLINE_TYPES = new Set(
  Object.values(documentSchema.nodes)
    .filter((type) => type.isInline)
    .map((type) => type.name),
);
/** Nodes holding blocks that marked may hand bare text, as a tight list does its items. */
const BLOCK_HOLDERS = new Set(["callout", "detailsContent", "blockquote"]);
const LIST_ITEMS = new Set(["listItem", "taskItem"]);

/**
 * Parsed JSON fitted to the schema where marked's tokens and it disagree:
 * bare text inside a block holder goes in a paragraph, and a list item that
 * starts with another block (a callout, an embed) gets the paragraph a list
 * item must start with.
 */
const fitTree = (node: JSONContent): JSONContent => {
  if (!node.content) return node;
  let content = node.content.map(fitTree);
  if (BLOCK_HOLDERS.has(node.type ?? "")) {
    const blocks: JSONContent[] = [];
    for (const child of content) {
      const last = blocks.at(-1);
      if (!INLINE_TYPES.has(child.type ?? "")) blocks.push(child);
      else if (last?.type === "paragraph" && last.attrs?.loose)
        last.content = [...(last.content ?? []), child];
      else blocks.push({ type: "paragraph", attrs: { loose: true }, content: [child] });
    }
    content = blocks.map((block) =>
      block.attrs?.loose ? { type: "paragraph", content: block.content ?? [] } : block,
    );
  }
  if (LIST_ITEMS.has(node.type ?? "") && content[0]?.type !== "paragraph")
    content = [{ type: "paragraph" }, ...content];
  return { ...node, content };
};

/**
 * Markdown parsed with its footnotes' definitions taken out first, so a
 * reference anywhere before or after finds its note and none is left as a
 * stray paragraph, then fitted to the schema.
 */
const parse = (markdown: string) => {
  footnoteDefinitions.clear();
  try {
    return fitTree(manager.parse(takeDefinitions(markdown)));
  } finally {
    footnoteDefinitions.clear();
  }
};

/**
 * A document tree from Markdown; empty Markdown is an empty document. It is
 * checked against the schema, so Markdown that cannot be a valid tree is
 * refused here rather than stored.
 */
export const parseMarkdown = (markdown: string) => {
  const doc = Node.fromJSON(
    documentSchema,
    markdown.trim() ? parse(markdown) : { type: "doc", content: [] },
  );
  if (doc.childCount) doc.check();
  return doc;
};

/** Markdown in the canonical form the editor would write it back as. */
export const normalizeMarkdown = (markdown: string) =>
  markdown.trim() ? serialize(parse(markdown)) : "";

/**
 * Makes `tr`'s document equal `next` by replacing only the range where the
 * two differ, so text on either side keeps its place and every cursor outside
 * the change maps through it untouched. `next` usually comes from Markdown
 * and has no block IDs; it takes the current ones first, so unchanged blocks
 * do not differ by their IDs alone.
 */
export const replaceDifference = <T extends Transform>(tr: T, built: Node): T =>
  writeDifference(tr, adoptIds(tr.doc, built));

/**
 * Makes `tr`'s document equal `next`, IDs and all, by replacing only where
 * they differ: text streaming onto the end of a block lands as just the new
 * words, which the editor draws in place and a cursor can follow.
 */
export const writeDifference = <T extends Transform>(tr: T, next: Node): T => {
  const start = tr.doc.content.findDiffStart(next.content);
  if (start == null) return tr;
  const end = tr.doc.content.findDiffEnd(next.content)!;
  // Both ends count from their own document's end; where the shared tail
  // overlaps the shared head, keep the shorter side inside the change.
  let endA = end.a;
  let endB = end.b;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  // A slice cut open inside a table is fitted on replace, by adding cells, so
  // the result is checked. Failing that, whole top-level blocks are swapped.
  const attempt = (from: number, toA: number, toB: number) => {
    const scratch = new Transform(tr.doc).replace(from, toA, next.slice(from, toB));
    return scratch.doc.eq(next) ? scratch : null;
  };
  const $start = tr.doc.resolve(start);
  const $end = tr.doc.resolve(endA);
  const from = $start.depth ? $start.before(1) : start;
  const toA = $end.depth ? $end.after(1) : endA;
  const written =
    attempt(start, endA, endB) ??
    attempt(from, toA, endB + toA - endA) ??
    new Transform(tr.doc).replaceWith(0, tr.doc.content.size, next.content);
  for (const step of written.steps) tr.step(step);
  return tr;
};
