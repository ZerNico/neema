import type { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { DocumentBlockMath, DocumentInlineMath } from "../../editor/math.ts";
import { MathView } from "./math-view.tsx";

/** The shared math nodes, drawn in the browser; the schema is unchanged. */
export const BrowserInlineMath = DocumentInlineMath.extend({
  addNodeView: () => ReactNodeViewRenderer(MathView, { as: "span" }),
});
export const BrowserBlockMath = DocumentBlockMath.extend({
  addNodeView: () => ReactNodeViewRenderer(MathView),
});

/**
 * A formula at the cursor, selected so its LaTeX field opens: on its own
 * line in an empty top-level paragraph, inside the text anywhere else. A
 * selection becomes its LaTeX and is replaced by it.
 */
export const insertFormula = (chain: ReturnType<Editor["chain"]>) =>
  chain.command(({ state, tr }) => {
    const { $from, from, to, empty } = state.selection;
    const latex = state.doc.textBetween(from, to, " ").trim();
    const alone =
      empty &&
      $from.depth === 1 &&
      $from.parent.type.name === "paragraph" &&
      !$from.parent.content.size;
    const node = state.schema.nodes[alone ? "blockMath" : "inlineMath"]!.create({ latex });
    if (alone) tr.replaceWith($from.before(), $from.after(), node);
    else tr.replaceSelectionWith(node);
    // Replacing a selection across blocks joins them, so the formula is found
    // from where the cursor ended, just after it.
    const at = alone ? $from.before() : tr.selection.from - node.nodeSize;
    tr.setSelection(NodeSelection.create(tr.doc, at));
    return true;
  });
