import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { isRemoteChange } from "../../editor/remote.ts";
import { DOCUMENT_LIMITS } from "../../schema.ts";
import { overCap, treeSize, type TreeSize } from "../../editor/limits.ts";

/**
 * Decides whether a local change keeps the tree within the limits. Every
 * local change is measured, since a formula's LaTeX grows hidden data without
 * growing the tree. A measure already past its limit may not grow, but the
 * change still goes through otherwise, so a document over a limit can shrink.
 */
export const capCheck =
  (measure: (doc: Node) => TreeSize) => (transaction: Transaction, before: Node) => {
    if (!transaction.docChanged || isRemoteChange(transaction)) return true;
    const after = measure(transaction.doc);
    if (overCap(transaction.doc, after) === null) return true;
    const was = measure(before);
    const limits: TreeSize = {
      blocks: DOCUMENT_LIMITS.blocks,
      attributes: DOCUMENT_LIMITS.chars,
      text: DOCUMENT_LIMITS.chars,
    };
    return (Object.keys(limits) as (keyof TreeSize)[]).every(
      (key) => after[key] <= limits[key] || after[key] <= was[key],
    );
  };

/**
 * Refuses typing that would take the tree past the limits the server
 * measures. The server would refuse the whole batch instead, losing the rest
 * of it too.
 */
export const SizeCap = Extension.create({
  name: "documentSizeCap",
  addProseMirrorPlugins() {
    const allowed = capCheck(treeSize);
    return [
      new Plugin({
        filterTransaction: (transaction, state) => allowed(transaction, state.doc),
      }),
    ];
  },
});
