import { Node, type MarkdownTokenizer } from "@tiptap/core";
import type { Node as TreeNode } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";

/** What an embed shows: a range of a live sheet, or one of its charts. */
export interface SheetEmbedAttrs {
  sheet: string;
  range: string | null;
  chart: string | null;
}

/** An embed's attributes when they name a sheet and exactly one of a range and a chart. */
export const embedAttrs = (attrs: Record<string, unknown>): SheetEmbedAttrs | null => {
  const { sheet, range, chart } = attrs;
  if (typeof sheet !== "string" || !sheet) return null;
  const hasRange = typeof range === "string" && range !== "";
  const hasChart = typeof chart === "string" && chart !== "";
  if (hasRange === hasChart) return null;
  return { sheet, range: hasRange ? range : null, chart: hasChart ? chart : null };
};

/** What an embed reads as where no values can be drawn: people's Markdown, a print caption. */
export const embedCaption = (attrs: SheetEmbedAttrs) =>
  attrs.range ? `Sheet range ${attrs.range}` : "Sheet chart";

const quoteValue = (value: string) => value.replace(/["\\]/g, "\\$&");
const SHORTCODE = /^\[sheet((?:[ \t]+[a-z]+="(?:\\.|[^"\\\n])*")+)[ \t]*\][ \t]*(?:\n+|$)/;
const ATTRIBUTE = /([a-z]+)="((?:\\.|[^"\\\n])*)"/g;

/** `[sheet id="…" range="…"]` alone on its line; anything else stays text. */
const tokenizer: MarkdownTokenizer = {
  name: "sheetEmbed",
  level: "block",
  start: (src) => {
    const match = /(^|\n)\[sheet[ \t]/.exec(src);
    return match ? match.index + match[1]!.length : -1;
  },
  tokenize: (src) => {
    const match = SHORTCODE.exec(src);
    if (!match) return undefined;
    const values: Record<string, string> = {};
    for (const [, key, value] of match[1]!.matchAll(ATTRIBUTE))
      values[key!] = value!.replace(/\\(.)/g, "$1");
    const attrs = embedAttrs({ sheet: values.id, range: values.range, chart: values.chart });
    return attrs ? { type: "sheetEmbed", raw: match[0], ...attrs } : undefined;
  },
};

/** An attribute kept on the element as `data-<name>`, absent when unset. */
const dataAttribute = (name: string) => ({
  default: null,
  parseHTML: (element: HTMLElement) => element.getAttribute(`data-${name}`) || null,
  renderHTML: (attributes: Record<string, unknown>) =>
    attributes[name] ? { [`data-${name}`]: attributes[name] } : {},
});

/**
 * A range of cells or a chart from a live sheet, drawn from that sheet's
 * current values wherever the document is read. The node holds only IDs and
 * A1 text: whoever reads it must be able to read the sheet as well. The model
 * reads and writes it as `[sheet id="…" range="Data!A1:D9"]` on its own line.
 */
export const SheetEmbed = Node.create({
  name: "sheetEmbed",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      sheet: dataAttribute("sheet"),
      range: dataAttribute("range"),
      chart: dataAttribute("chart"),
    };
  },
  parseHTML: () => [{ tag: "div[data-sheet-embed]" }],
  renderHTML: ({ node, HTMLAttributes }) => {
    const attrs = embedAttrs(node.attrs);
    return [
      "div",
      { ...HTMLAttributes, "data-sheet-embed": "" },
      ["p", { class: "sheet-embed-caption" }, attrs ? embedCaption(attrs) : ""],
    ];
  },
  renderText: ({ node }) => {
    const attrs = embedAttrs(node.attrs);
    return attrs ? embedCaption(attrs) : "";
  },
  markdownTokenizer: tokenizer,
  parseMarkdown: (token, helpers) =>
    helpers.createNode("sheetEmbed", {
      sheet: token.sheet as string,
      range: (token.range as string | null) ?? null,
      chart: (token.chart as string | null) ?? null,
    }),
  renderMarkdown: (node) => {
    const attrs = embedAttrs(node.attrs ?? {});
    if (!attrs) return "";
    const what = attrs.range
      ? `range="${quoteValue(attrs.range)}"`
      : `chart="${quoteValue(attrs.chart!)}"`;
    return `[sheet id="${quoteValue(attrs.sheet)}" ${what}]`;
  },
});

/**
 * The tree for people's Markdown: each embed as an italic line naming what it
 * showed, since Markdown holds no values. Italic text reads back as text,
 * never as an embed.
 */
export const plainSheetEmbeds = (doc: TreeNode): TreeNode => {
  const embeds: { position: number; node: TreeNode }[] = [];
  doc.descendants((node, position) => {
    if (node.type.name === "sheetEmbed") embeds.push({ position, node });
    return node.isBlock;
  });
  if (!embeds.length) return doc;
  const { schema } = doc.type;
  const tr = new Transform(doc);
  for (const { position, node } of embeds.toReversed()) {
    const attrs = embedAttrs(node.attrs);
    const at = tr.mapping.map(position);
    if (!attrs) tr.delete(at, at + node.nodeSize);
    else
      tr.replaceWith(
        at,
        at + node.nodeSize,
        schema.nodes.paragraph!.create(
          null,
          schema.text(embedCaption(attrs), [schema.marks.italic!.create()]),
        ),
      );
  }
  return tr.doc;
};
