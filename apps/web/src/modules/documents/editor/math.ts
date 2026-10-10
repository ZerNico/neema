import type { JSONContent, MarkdownTokenizer } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";

/**
 * Inline LaTeX the way Pandoc reads it: no space just inside either dollar
 * and no digit straight after the closing one, so "$5 and $10" stays prices.
 */
const INLINE = /^\$(?=[^\s$])((?:\\.|[^\\$\n])+?)(?<=[^\s\\])\$(?!\d)/;
/** Models also write `$$x$$` mid-sentence; inside a line that is inline math too. */
const INLINE_DOUBLE = /^\$\$(?=[^\s$])((?:\\.|[^\\$\n])+?)(?<=\S)\$\$/;
/** Display math: `$$` lines around the LaTeX, or `$$…$$` alone on its line. */
const BLOCK_LINES = /^\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$[ \t]*(?:\n+|$)/;
const BLOCK_LINE = /^\$\$([^\n$](?:[^\n$]*[^\n$])?)\$\$[ \t]*(?:\n+|$)/;

/** A dollar a backslash does not escape. */
const OPENING = /(?<!\\)\$/;

const inlineLatex = (src: string) => {
  const match = INLINE_DOUBLE.exec(src) ?? INLINE.exec(src);
  return match ? { raw: match[0], latex: match[1]!.trim() } : null;
};

/**
 * Every dollar in text a person typed, escaped as upstream escapes `*` and
 * `_`: a pair split by formatting ("$**x**$") would otherwise come back as a
 * formula, and one text node cannot see its neighbours.
 */
export const escapeMathDollars = (text: string) =>
  // Upstream has escaped every backslash, so an odd run before a dollar escapes it.
  text.replace(/(\\*)\$/g, (whole, backslashes: string) =>
    backslashes.length % 2 === 0 ? `${backslashes}\\$` : whole,
  );

/**
 * A formula a digit follows is written `$$x$$`: the closing `$` of `$x$2`
 * reads as a price. Marked on the JSON before writing, since a node's writer
 * sees only what comes before it.
 */
export const markMathBeforeDigits = (node: JSONContent): JSONContent => {
  if (!node.content) return node;
  const content = node.content.map((child, index) => {
    const next = node.content![index + 1];
    return child.type === "inlineMath" && next?.type === "text" && /^\d/.test(next.text ?? "")
      ? { ...child, attrs: { ...child.attrs, beforeDigit: true } }
      : markMathBeforeDigits(child);
  });
  return { ...node, content };
};

const inlineTokenizer: MarkdownTokenizer = {
  name: "inlineMath",
  level: "inline",
  start: (src) => src.search(OPENING),
  tokenize: (src) => {
    const found = inlineLatex(src);
    return found ? { type: "inlineMath", raw: found.raw, latex: found.latex } : undefined;
  },
};

const blockTokenizer: MarkdownTokenizer = {
  name: "blockMath",
  level: "block",
  start: (src) => {
    const match = /(^|\n)\$\$/.exec(src);
    return match ? match.index + match[1]!.length : -1;
  },
  tokenize: (src) => {
    const match = BLOCK_LINES.exec(src) ?? BLOCK_LINE.exec(src);
    const latex = match?.[1]?.trim();
    return match && latex ? { type: "blockMath", raw: match[0], latex } : undefined;
  },
};

/** One line of LaTeX inside text; Markdown `$…$`, or `$$…$$` before a digit. */
export const DocumentInlineMath = InlineMath.extend({
  markdownTokenizer: inlineTokenizer,
  renderMarkdown: (node) => {
    const latex = String(node.attrs?.latex ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const fence = node.attrs?.beforeDigit ? "$$" : "$";
    return latex ? `${fence}${latex}${fence}` : "";
  },
});

/** A display formula, a block of its own; Markdown `$$` lines around the LaTeX. */
export const DocumentBlockMath = BlockMath.extend({
  markdownTokenizer: blockTokenizer,
  renderMarkdown: (node) => {
    const latex = String(node.attrs?.latex ?? "").trim();
    return latex ? `$$\n${latex}\n$$` : "";
  },
});
