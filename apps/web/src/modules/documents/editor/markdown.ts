import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { isolatedMarked } from "./isolated-marked.ts";
import { Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { adoptIds } from "./block-ids.ts";
import { footnoteDefinitions, numberFootnotes } from "./blocks.ts";
import { plainChips } from "./chips.ts";
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
 * The Markdown the model reads and writes: chips as shortcodes
 * (`[date value="…"]`, `[@ id="…" label="…"]`), so it can tell them from text.
 */
export const toModelMarkdown = (node: Node) => serialize(node.toJSON());

/**
 * The Markdown a tree reads as for people, for Copy and export: footnotes as
 * numbered references with their definitions at the end, as GitHub draws them.
 */
export const toMarkdown = (node: Node) => {
  const { json, notes } = numberFootnotes(plainChips(node).toJSON() as JSONContent);
  const markdown = serialize(json);
  if (!notes.length) return markdown;
  const definitions = notes.map((note, index) => `[^${index + 1}]: ${note}`).join("\n");
  return markdown ? `${markdown}\n\n${definitions}` : definitions;
};

/** A footnote's definition: its label, then its note, lines indented under it continuing it. */
const DEFINITION = /^\[\^([^\]\s]+)\]:[ \t]+(.*(?:\n(?: {2,}|\t).*)*)\n?/gm;

/**
 * Markdown parsed with its footnotes' definitions taken out first, so a
 * reference anywhere before or after finds its note and none is left as a
 * stray paragraph.
 */
const parse = (markdown: string) => {
  footnoteDefinitions.clear();
  const body = markdown.replace(DEFINITION, (_line, label: string, note: string) => {
    footnoteDefinitions.set(label, note.replace(/\s*\n\s*/g, " ").trim());
    return "";
  });
  try {
    // Where definitions stood, blank lines would read as empty paragraphs.
    return manager.parse(body === markdown ? body : body.replace(/\n{3,}/g, "\n\n").trimEnd());
  } finally {
    footnoteDefinitions.clear();
  }
};

/** A document tree from Markdown; empty Markdown is an empty document. */
export const parseMarkdown = (markdown: string) =>
  Node.fromJSON(documentSchema, markdown.trim() ? parse(markdown) : { type: "doc", content: [] });

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
