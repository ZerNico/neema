import { createInlineMarkdownSpec, Node } from "@tiptap/core";
import { Mention } from "@tiptap/extension-mention";

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

const SHORTCODE_ATTRIBUTE = /(\w+)="([^"]*)"/g;
const attributesOf = (source: string) =>
  Object.fromEntries(
    [...source.matchAll(SHORTCODE_ATTRIBUTE)].map((match) => [match[1]!, match[2]!]),
  );

/**
 * Markdown for people and exports: each chip as the text it stands for. The
 * model's view keeps the shortcodes so it can tell a chip from typed text.
 */
export const plainChips = (markdown: string) =>
  markdown
    .replace(/\[date ([^\]]*)\]/g, (whole, source: string) => attributesOf(source).value ?? whole)
    .replace(/\[@ ([^\]]*)\]/g, (whole, source: string) => {
      const { label, id } = attributesOf(source);
      return label || id ? `@${label ?? id}` : whole;
    });
