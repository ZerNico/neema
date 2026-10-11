import { Mark, type MarkdownTokenizer } from "@tiptap/core";
import { Underline } from "@tiptap/extension-underline";
import { inlineStart } from "./inline-start.ts";

/**
 * Inline formats plain Markdown lacks, written as the HTML tags GitHub draws
 * inside Markdown: `<u>` and `<mark>`. Upstream writes underline as
 * `++text++`, which read "C++ and C++" back as underlined text.
 */
/** How far past its opening tag a closing one is looked for; past it, the tag is text. */
const TAG_WINDOW = 4_000;

/** Whether the character at `at` is escaped by an odd run of backslashes before it. */
const escaped = (src: string, at: number) => {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && src[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
};

const tagTokenizer = (name: string, tag: string): MarkdownTokenizer => {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  return {
    name,
    level: "inline",
    start: (src) => inlineStart(src, open),
    tokenize: (src, _tokens, lexer) => {
      if (!src.startsWith(open)) return undefined;
      // The first closing tag nobody escaped, within a window: an unclosed tag
      // looked for one to the end of the text, every time, which took seconds.
      const window = src.slice(0, open.length + TAG_WINDOW + close.length);
      let at = window.indexOf(close, open.length + 1);
      while (at !== -1 && escaped(window, at)) at = window.indexOf(close, at + 1);
      // Unclosed, the tag is text, as raw HTML is here. Left to marked, it became an
      // HTML token, and upstream's handling of many of those is quadratic.
      if (at === -1) return { type: "text", raw: open, text: open };
      return {
        type: name,
        raw: src.slice(0, at + close.length),
        tokens: lexer.inlineTokens(src.slice(open.length, at)),
      };
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
