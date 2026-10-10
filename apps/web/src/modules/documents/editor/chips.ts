import { createInlineMarkdownSpec, Node } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";
import type { Node as TreeNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date as a chip inside a line: one value, shown as a date and changed with
 * a picker. In Markdown it is `[date value="2026-10-09"]`, which the model
 * reads and writes; exports show the date itself.
 */
export const DateChip = Node.create({
  name: "dateChip",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      value: {
        default: null,
        parseHTML: (element) => {
          const value = element.getAttribute("data-value");
          return value && ISO_DATE.test(value) ? value : null;
        },
        renderHTML: (attributes) => ({ "data-value": attributes.value }),
      },
    };
  },
  parseHTML: () => [{ tag: "span[data-date-chip]" }],
  renderHTML: ({ node, HTMLAttributes }) => [
    "span",
    { ...HTMLAttributes, "data-date-chip": "" },
    String(node.attrs.value ?? ""),
  ],
  renderText: ({ node }) => String(node.attrs.value ?? ""),
  ...createInlineMarkdownSpec({
    nodeName: "dateChip",
    name: "date",
    selfClosing: true,
    allowedAttributes: ["value"],
  }),
});

/**
 * A person, by account, inside a line. The shared node only; the browser adds
 * the `@` suggestions. In Markdown it is `[@ id="…" label="…"]`.
 */
export const PersonMention = Mention.configure({
  renderText: ({ node }) => `@${String(node.attrs.label ?? node.attrs.id ?? "")}`,
});

/**
 * The tree for people and exports: each chip as the text it stands for. The
 * model's view keeps the shortcodes so it can tell a chip from typed text.
 * Done on the tree, not the Markdown, so the same characters typed into a
 * code block stay as they are.
 */
export const plainChips = (doc: TreeNode): TreeNode => {
  const chips: { position: number; node: TreeNode }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "dateChip" || node.type.name === "mention")
      chips.push({ position, node });
    return true;
  });
  if (!chips.length) return doc;
  const tr = new Transform(doc);
  for (const { position, node } of chips.toReversed()) {
    const text =
      node.type.name === "dateChip"
        ? String(node.attrs.value ?? "")
        : `@${String(node.attrs.label ?? node.attrs.id ?? "")}`;
    const at = tr.mapping.map(position);
    if (text && text !== "@")
      tr.replaceWith(at, at + node.nodeSize, doc.type.schema.text(text, node.marks));
    else tr.delete(at, at + node.nodeSize);
  }
  return tr.doc;
};
