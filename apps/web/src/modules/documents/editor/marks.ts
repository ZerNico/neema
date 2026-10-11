import { Mark, type MarkdownTokenizer } from "@tiptap/core";
import { Underline } from "@tiptap/extension-underline";

/**
 * Inline formats plain Markdown lacks, written as the HTML tags GitHub draws
 * inside Markdown: `<u>` and `<mark>`. Upstream writes underline as
 * `++text++`, which read "C++ and C++" back as underlined text.
 */
const tagTokenizer = (name: string, tag: string): MarkdownTokenizer => {
  const pattern = new RegExp(`^<${tag}>([\\s\\S]+?)</${tag}>`);
  return {
    name,
    level: "inline",
    start: (src) => src.indexOf(`<${tag}>`),
    tokenize: (src, _tokens, lexer) => {
      const match = pattern.exec(src);
      return match
        ? { type: name, raw: match[0], tokens: lexer.inlineTokens(match[1]!) }
        : undefined;
    },
  };
};

export const DocumentUnderline = Underline.extend({
  markdownTokenizer: tagTokenizer("underline", "u"),
  renderMarkdown: (node, h) => `<u>${h.renderChildren(node)}</u>`,
});

/** Text marked as a highlighter would, one colour, as Markdown's `<mark>` has no other. */
export const Highlight = Mark.create({
  name: "highlight",
  parseHTML: () => [{ tag: "mark" }],
  renderHTML: ({ HTMLAttributes }) => ["mark", HTMLAttributes, 0],
  markdownTokenizer: tagTokenizer("highlight", "mark"),
  parseMarkdown: (token, helpers) =>
    helpers.applyMark("highlight", helpers.parseInline(token.tokens ?? [])),
  renderMarkdown: (node, h) => `<mark>${h.renderChildren(node)}</mark>`,
  addCommands() {
    return {
      toggleHighlight:
        () =>
        ({ commands }) =>
          commands.toggleMark(this.name),
    };
  },
});

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    highlight: {
      /** Marks the selection as highlighted, or clears it. */
      toggleHighlight: () => ReturnType;
    };
  }
}
