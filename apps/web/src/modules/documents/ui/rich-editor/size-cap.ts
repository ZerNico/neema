import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, type Transaction } from "@tiptap/pm/state";
import { isRemoteChange } from "../../editor/remote.ts";
import { overCap } from "../../editor/limits.ts";

/**
 * Decides whether a local change keeps the tree within the limits. One walk
 * of the tree, so it runs on every change that grows it.
 */
export const capCheck =
  (fits: (doc: Node) => boolean) => (transaction: Transaction, before: Node) => {
    if (!transaction.docChanged || isRemoteChange(transaction)) return true;
    if (transaction.doc.content.size <= before.content.size) return true;
    return fits(transaction.doc);
  };

/**
 * Refuses typing that would take the tree past the limits the server
 * measures. The server would refuse the whole batch instead, losing the rest
 * of it too.
 */
export const SizeCap = Extension.create({
  name: "documentSizeCap",
  addProseMirrorPlugins() {
    const allowed = capCheck((doc) => overCap(doc) === null);
    return [
      new Plugin({
        filterTransaction: (transaction, state) => allowed(transaction, state.doc),
      }),
    ];
  },
});
