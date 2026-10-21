import { Marked, type Token, type Tokens } from "marked";
import { answerExcerpt } from "../../excerpt.ts";
import { COLORS } from "./styles.ts";

const escape = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const safeHref = (href: string) => {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
};

const TEXT = `margin:0 0 16px;font-size:15px;line-height:24px;color:${COLORS.foreground}`;
const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px";

/**
 * Model text as email HTML. The text is the model's, so nothing in it reaches
 * the page as markup: raw HTML is shown as text, images are dropped, and only
 * web and mail links stay links. Mail clients ignore style sheets, so every
 * element carries its own style.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text, block }) => (block ? `<p style="${TEXT}">${escape(text)}</p>` : escape(text)),
    image: ({ text }) => escape(text),
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      return safe
        ? `<a href="${escape(safe)}" style="color:${COLORS.primary};text-decoration:underline">${label}</a>`
        : label;
    },
    paragraph({ tokens }) {
      return `<p style="${TEXT}">${this.parser.parseInline(tokens)}</p>`;
    },
    heading({ tokens, depth }) {
      const size = depth <= 1 ? 20 : depth === 2 ? 18 : 16;
      return `<p style="margin:24px 0 12px;font-size:${size}px;line-height:1.3;font-weight:600;color:${COLORS.foreground}">${this.parser.parseInline(tokens)}</p>`;
    },
    code({ text, lang }) {
      // A ```ui block is interactive and means nothing outside the app.
      if (lang === "ui") return "";
      return `<pre style="margin:0 0 16px;padding:12px;border-radius:16px;background:${COLORS.subtle};white-space:pre-wrap;${MONO}">${escape(text)}</pre>`;
    },
    codespan: ({ text }) =>
      `<code style="padding:1px 4px;border-radius:4px;background:${COLORS.subtle};${MONO}">${text}</code>`,
    blockquote({ tokens }) {
      return `<blockquote style="margin:0 0 16px;padding-left:12px;border-left:3px solid ${COLORS.border};color:${COLORS.muted}">${this.parser.parse(tokens)}</blockquote>`;
    },
    hr: () => `<hr style="margin:24px 0;border:none;border-top:1px solid ${COLORS.border}" />`,
    list(token) {
      const tag = token.ordered ? "ol" : "ul";
      const items = token.items
        .map((item) => `<li style="margin:0 0 4px">${this.parser.parse(item.tokens)}</li>`)
        .join("");
      return `<${tag} style="margin:0 0 16px;padding-left:24px;font-size:15px;line-height:24px;color:${COLORS.foreground}">${items}</${tag}>`;
    },
    table(token) {
      const cell = (value: Tokens.TableCell, header: boolean) =>
        `<td style="padding:6px 10px;border:1px solid ${COLORS.border};font-size:14px;line-height:20px;${header ? `font-weight:600;background:${COLORS.subtle}` : ""}">${this.parser.parseInline(value.tokens)}</td>`;
      const head = `<tr>${token.header.map((value) => cell(value, true)).join("")}</tr>`;
      const rows = token.rows
        .map((row) => `<tr>${row.map((value) => cell(value, false)).join("")}</tr>`)
        .join("");
      return `<table class="data" cellpadding="0" cellspacing="0" style="margin:0 0 16px;border-collapse:collapse">${head}${rows}</table>`;
    },
  },
});

// Citation markers resolve to sources only inside the app.
const withoutCitations = (markdown: string) =>
  markdown.replace(/^\[\^[^\]]+\]:.*$/gm, "").replace(/\[\^[^\]]*\]/g, "");

/**
 * The start of an answer as email HTML, cut between blocks so a list or a
 * table is never left half open. `truncated` says there is more in the chat.
 */
export const answerHtml = (markdown: string, limit = 1500) => {
  const tokens = marked.lexer(withoutCitations(markdown));
  const blocks = tokens.filter((token) => token.type !== "space");
  const kept: Token[] = [];
  let length = 0;
  for (const block of blocks) {
    if (kept.length > 0 && length + block.raw.length > limit) break;
    kept.push(block);
    length += block.raw.length;
  }
  // One block far past the limit (a long table or listing) gives way to plain words.
  if (length > limit * 4)
    return {
      html: `<p style="${TEXT}">${escape(answerExcerpt(markdown, limit))}</p>`,
      truncated: true,
    };
  const html = marked.parser(Object.assign(kept, { links: tokens.links }));
  return { html, truncated: kept.length < blocks.length };
};
