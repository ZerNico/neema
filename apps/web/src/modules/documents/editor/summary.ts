import type { Node } from "@tiptap/pm/model";
import { DOCUMENT_LIMITS } from "../schema.ts";
import { isBlock } from "./block-ids.ts";

/** What cards and lists show of a document, without its Markdown. */
export interface DocumentSummary {
  /** The characters a person wrote: the tree's text, no Markdown syntax. */
  textLength: number;
  tasksDone: number;
  tasksTotal: number;
}

/** Derives the summary from the tree, in one pass. */
export const summarize = (doc: Node): DocumentSummary => {
  let tasksDone = 0;
  let tasksTotal = 0;
  doc.descendants((node) => {
    if (node.type.name !== "taskItem") return true;
    tasksTotal++;
    if (node.attrs.checked === true) tasksDone++;
    return true;
  });
  return { textLength: doc.textContent.length, tasksDone, tasksTotal };
};

const attributeChars = (attrs: Record<string, unknown>) => {
  let total = 0;
  for (const value of Object.values(attrs)) if (typeof value === "string") total += value.length;
  return total;
};

/**
 * Why a tree is past the size limits, or null. The server and the editor both
 * ask this: its text, its blocks (an empty paragraph or a planned section
 * writes no text), and attribute text (IDs, intents, links, comment threads)
 * under a budget of its own.
 */
export const overCap = (doc: Node) => {
  let blocks = 0;
  let attributes = 0;
  doc.descendants((node) => {
    if (isBlock(node)) blocks++;
    attributes += attributeChars(node.attrs);
    for (const mark of node.marks) attributes += attributeChars(mark.attrs);
    return true;
  });
  if (blocks > DOCUMENT_LIMITS.blocks) return `document exceeds ${DOCUMENT_LIMITS.blocks} blocks`;
  if (attributes > DOCUMENT_LIMITS.chars) return "document holds too much hidden data";
  if (doc.textContent.length > DOCUMENT_LIMITS.chars)
    return `document exceeds ${DOCUMENT_LIMITS.chars} characters`;
  return null;
};
