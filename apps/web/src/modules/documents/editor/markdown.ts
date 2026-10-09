import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";
import { adoptIds } from "./block-ids.ts";
import { plainChips } from "./chips.ts";
import { documentExtensions, fenceFor } from "./extensions.ts";

export const documentSchema = getSchema(documentExtensions);
const manager = new MarkdownManager({ extensions: documentExtensions });

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
  manager.serialize(fenceInlineCode(withoutEmptyParagraphs(withoutPending(json))));

/**
 * The Markdown the model reads and writes: chips as shortcodes
 * (`[date value="…"]`, `[@ id="…" label="…"]`), so it can tell them from text.
 */
export const toModelMarkdown = (node: Node) => serialize(node.toJSON());

/** The Markdown a tree reads as for people: stored beside it for cards, search and Copy. */
export const toMarkdown = (node: Node) => plainChips(toModelMarkdown(node));

/** A document tree from Markdown; empty Markdown is an empty document. */
export const parseMarkdown = (markdown: string) =>
  Node.fromJSON(
    documentSchema,
    markdown.trim() ? manager.parse(markdown) : { type: "doc", content: [] },
  );

/** Markdown in the canonical form the editor would write it back as. */
export const normalizeMarkdown = (markdown: string) =>
  markdown.trim() ? serialize(manager.parse(markdown)) : "";

/**
 * Makes `tr`'s document equal `next` by replacing only the range where the
 * two differ, so text on either side keeps its place and every cursor outside
 * the change maps through it untouched. `next` usually comes from Markdown
 * and has no block IDs; it takes the current ones first, so unchanged blocks
 * do not differ by their IDs alone.
 */
export const replaceDifference = <T extends Transform>(tr: T, built: Node): T => {
  const next = adoptIds(tr.doc, built);
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
  tr.replace(start, endA, next.slice(start, endB));
  return tr;
};
