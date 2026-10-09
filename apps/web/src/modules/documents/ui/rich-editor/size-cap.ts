import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { toMarkdown } from "../../editor/markdown.ts";
import { isRemoteChange } from "../../editor/remote.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";

/**
 * Markdown adds a few characters per node, so a document this small cannot
 * reach the cap and is not measured. Only wide table padding outgrows it,
 * and the server still refuses that.
 */
const MEASURED_FROM = DOCUMENT_LIMITS.chars / 8;
/** The most Markdown one unit of tree size turns into, bar table padding. */
const CHARS_PER_UNIT = 4;

/**
 * Decides whether a local change keeps the stored Markdown within the cap.
 * Serializing takes tens of milliseconds near the cap, so it measures only
 * when growth since the last measurement could have reached it.
 */
export const capCheck = (measure: (doc: Node) => number, cap: number = DOCUMENT_LIMITS.chars) => {
  let last: { size: number; length: number } | null = null;
  return (transaction: Transaction, before: Node) => {
    if (!transaction.docChanged || isRemoteChange(transaction)) return true;
    const size = transaction.doc.content.size;
    if (size <= Math.max(MEASURED_FROM, before.content.size)) return true;
    if (last && last.length + (size - last.size) * CHARS_PER_UNIT <= cap) return true;
    const length = measure(transaction.doc);
    last = { size, length };
    return length <= cap;
  };
};

/**
 * Refuses typing that would take the stored Markdown past the size cap. The
 * server would refuse the whole batch instead, losing the rest of it too.
 */
export const SizeCap = Extension.create({
  name: "documentSizeCap",
  addProseMirrorPlugins() {
    const allowed = capCheck((doc) => toMarkdown(doc).length);
    return [
      new Plugin({
        filterTransaction: (transaction, state) => allowed(transaction, state.doc),
      }),
    ];
  },
});
