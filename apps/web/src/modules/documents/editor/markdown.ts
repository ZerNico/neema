import { getSchema, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node } from "@tiptap/pm/model";
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type * as Y from "yjs";
import { DOCUMENT_FIELD } from "../text.ts";
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

const serialize = (json: JSONContent) =>
  manager.serialize(fenceInlineCode(withoutEmptyParagraphs(json)));

/** The Markdown a tree reads as: what the model sees and what is stored beside it. */
export const toMarkdown = (node: Node) => serialize(node.toJSON());

/** Markdown in the canonical form the editor would write it back as. */
export const normalizeMarkdown = (markdown: string) =>
  markdown.trim() ? serialize(manager.parse(markdown)) : "";

/** The document's shared tree. */
export const documentTree = (doc: Y.Doc) => doc.getXmlFragment(DOCUMENT_FIELD);

/** The document as Markdown, read from its shared tree. */
export const readMarkdown = (doc: Y.Doc) =>
  toMarkdown(yXmlFragmentToProseMirrorRootNode(documentTree(doc), documentSchema));

/**
 * Makes the shared tree read as `markdown`, changing only what differs, so
 * someone typing in another block keeps their place and their text. Runs in
 * one transaction; empty Markdown empties the tree.
 */
export const writeMarkdown = (doc: Y.Doc, markdown: string) => {
  const node = Node.fromJSON(
    documentSchema,
    markdown.trim() ? manager.parse(markdown) : { type: "doc", content: [] },
  );
  doc.transact(() => {
    updateYFragment(doc, documentTree(doc), node, { mapping: new Map(), isOMark: new Map() });
  });
};
