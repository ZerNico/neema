import type { Node } from "@tiptap/pm/model";
import { type Localized, localized } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { DOCUMENT_LIMITS } from "../schema.ts";
import { isBlock } from "./block-ids.ts";

const attributeChars = (attrs: Record<string, unknown>) => {
  let total = 0;
  for (const value of Object.values(attrs)) if (typeof value === "string") total += value.length;
  return total;
};

/**
 * What the size limits count: the tree's text, its blocks (an empty paragraph
 * or a planned section writes no text), and attribute text (IDs, intents,
 * links, formulas, comment threads) under a budget of its own.
 */
export const treeSize = (doc: Node) => {
  let blocks = 0;
  let attributes = 0;
  doc.descendants((node) => {
    if (isBlock(node)) blocks++;
    attributes += attributeChars(node.attrs);
    for (const mark of node.marks) attributes += attributeChars(mark.attrs);
    return true;
  });
  return { blocks, attributes, text: doc.textContent.length };
};
export type TreeSize = ReturnType<typeof treeSize>;

/** Why a tree is past the size limits, or null. The server and the editor both ask this. */
export const overCap = (doc: Node, size: TreeSize = treeSize(doc)): Localized | null => {
  if (size.blocks > DOCUMENT_LIMITS.blocks)
    return localized(m.documents_error_too_many_blocks, { max: DOCUMENT_LIMITS.blocks });
  if (size.attributes > DOCUMENT_LIMITS.chars)
    return localized(m.documents_error_too_much_hidden_data);
  if (size.text > DOCUMENT_LIMITS.chars)
    return localized(m.documents_error_too_many_chars, { max: DOCUMENT_LIMITS.chars });
  return null;
};
