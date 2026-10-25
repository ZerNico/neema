import { m } from "~/paraglide/messages.js";
import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Details, Footnote, type CalloutKind } from "../../editor/blocks.ts";
import { FootnoteView } from "./footnote-view.tsx";

type Chain = ReturnType<Editor["chain"]>;

/**
 * A collapsible section drawn with a fold button. Folding is this reader's
 * own: the button changes only the view, so it is no step and nobody else's
 * section folds.
 */
export const BrowserDetails = Details.extend({
  addNodeView: () => () => {
    let open = true;
    const dom = document.createElement("div");
    dom.dataset.details = "";
    dom.dataset.open = "true";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.contentEditable = "false";
    toggle.className = "details-toggle";
    const label = () => {
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute(
        "aria-label",
        open ? m.documents_details_fold() : m.documents_details_unfold(),
      );
    };
    label();
    // A click must not move the caret into the title.
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => {
      open = !open;
      dom.dataset.open = String(open);
      label();
    });
    const content = document.createElement("div");
    content.className = "details-body";
    dom.append(toggle, content);
    return {
      dom,
      contentDOM: content,
      // The fold button and the open mark are this view's own, not the document's.
      ignoreMutation: (mutation) =>
        toggle.contains(mutation.target) ||
        (mutation.type === "attributes" && mutation.target === dom),
    };
  },
});

/** A footnote drawn as its number, its note opening beneath it. */
export const BrowserFootnote = Footnote.extend({
  addNodeView: () => ReactNodeViewRenderer(FootnoteView, { as: "span" }),
});

/**
 * Puts the selected blocks in a callout of `kind`, or makes the callout the
 * selection is in that kind.
 */
export const setCallout = (kind: CalloutKind) => (chain: Chain) =>
  chain.command(({ state, tr, commands }) => {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name !== "callout") continue;
      tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, kind });
      return true;
    }
    return commands.wrapIn("callout", { kind });
  });

/**
 * A collapsible section where the cursor is: in place of an empty paragraph,
 * else after the block it is in, with the caret in its title.
 */
export const insertDetails = (chain: Chain) =>
  chain.command(({ state, tr }) => {
    const { schema } = state;
    const section = schema.nodes.details!.create(null, [
      schema.nodes.detailsSummary!.create(),
      schema.nodes.detailsContent!.create(null, schema.nodes.paragraph!.create()),
    ]);
    const { $from } = state.selection;
    const empty = $from.parent.type.name === "paragraph" && !$from.parent.content.size;
    const at = empty ? $from.before() : $from.after(Math.max(1, $from.depth));
    if (empty) tr.replaceWith(at, $from.after(), section);
    else tr.insert(at, section);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    return true;
  });

/** A footnote at the cursor, selected so its note opens to be written. */
export const insertFootnote = (chain: Chain) =>
  chain.command(({ state, tr }) => {
    const node = state.schema.nodes.footnote!.create({ note: "" });
    tr.replaceSelectionWith(node);
    tr.setSelection(NodeSelection.create(tr.doc, tr.selection.from - node.nodeSize));
    return true;
  });
