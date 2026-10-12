import { Node, type JSONContent, type MarkdownTokenizer } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { inlineStart } from "./inline-start.ts";
import { blockStart } from "./block-start.ts";

/**
 * Blocks beyond what plain Markdown has, each written as the Markdown that
 * GitHub draws: a callout as an alert (`> [!NOTE]`), a collapsible section as
 * `<details>`, and a footnote as Pandoc's inline `^[note]` for the model, or
 * `[^1]` with its definition at the end for people (`markdown.ts`).
 */

export const CALLOUT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutKind = (typeof CALLOUT_KINDS)[number];
const isCalloutKind = (value: unknown): value is CalloutKind =>
  typeof value === "string" && (CALLOUT_KINDS as readonly string[]).includes(value);

/** Each line's `>` and the one space after it, as a blockquote takes them off. */
const unquote = (lines: string[]) => lines.map((line) => line.replace(/^ {0,3}> ?/, "")).join("\n");

/**
 * A quoted block's lines: every line from the first that starts with `>`.
 * Read a line at a time, never splitting the rest of the document, which
 * this runs on for every block.
 */
const quotedLines = (src: string) => {
  const lines: string[] = [];
  for (let at = 0; at < src.length;) {
    const end = src.indexOf("\n", at);
    const line = src.slice(at, end === -1 ? undefined : end);
    if (!/^ {0,3}>/.test(line)) break;
    lines.push(line);
    if (end === -1) break;
    at = end + 1;
  }
  return lines;
};

/** Children rendered and quoted line by line, blank lines kept as a bare `>`. */
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => (line.trim() ? `> ${line}` : ">"))
    .join("\n");

const calloutTokenizer: MarkdownTokenizer = {
  name: "callout",
  level: "block",
  start: blockStart(/ {0,3}> ?\[!/),
  tokenize: (src, _tokens, lexer) => {
    const lines = quotedLines(src);
    const kind = /^ {0,3}> ?\[!(\w+)\][ \t]*$/.exec(lines[0] ?? "")?.[1]?.toLowerCase();
    if (!isCalloutKind(kind)) return undefined;
    const raw = lines.join("\n");
    return {
      type: "callout",
      raw: src.startsWith(`${raw}\n`) ? `${raw}\n` : raw,
      kind,
      tokens: lexer.blockTokens(unquote(lines.slice(1))),
    };
  },
};

/** A note, tip or warning set apart from the text around it: blocks inside a coloured frame. */
export const Callout = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      kind: {
        default: "note",
        parseHTML: (element) => {
          const kind = element.getAttribute("data-callout");
          return isCalloutKind(kind) ? kind : "note";
        },
        renderHTML: (attributes) => ({ "data-callout": attributes.kind }),
      },
    };
  },
  parseHTML: () => [{ tag: "div[data-callout]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", HTMLAttributes, 0],
  markdownTokenizer: calloutTokenizer,
  parseMarkdown: (token, helpers) => {
    const children = helpers.parseChildren(token.tokens ?? []);
    return helpers.createNode(
      "callout",
      { kind: token.kind as CalloutKind },
      children.length ? children : [helpers.createNode("paragraph")],
    );
  },
  renderMarkdown: (node, h) => {
    const kind = isCalloutKind(node.attrs?.kind) ? node.attrs.kind : "note";
    const body = (node.content ?? []).map((child) => quote(h.renderChildren([child])));
    // The alert's line, then each block quoted, blocks apart by a bare `>`.
    return `> [!${kind.toUpperCase()}]\n${body.join("\n>\n")}`;
  },
});

/**
 * A `<details>` block's extent: through the `</details>` that closes it,
 * nested ones counted and lines inside fenced code skipped, read a line at a time.
 */
const detailsExtent = (src: string) => {
  let depth = 0;
  let fence: string | null = null;
  for (let at = 0; at < src.length;) {
    const end = src.indexOf("\n", at);
    const line = src.slice(at, end === -1 ? undefined : end);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    } else if (marker) fence = marker;
    else if (/^\s*<details>\s*$/i.test(line)) depth++;
    else if (/^\s*<\/details>\s*$/i.test(line) && --depth === 0) return at + line.length;
    if (end === -1) break;
    at = end + 1;
  }
  return -1;
};

const detailsTokenizer: MarkdownTokenizer = {
  name: "details",
  level: "block",
  start: blockStart(/<details>[ \t]*\n/i),
  tokenize: (src, _tokens, lexer) => {
    const head = /^<details>[ \t]*\n<summary>(.*?)<\/summary>[ \t]*(?:\n|$)/i.exec(src);
    if (!head) return undefined;
    const end = detailsExtent(src);
    if (end === -1) return undefined;
    const body = src.slice(head[0].length, src.lastIndexOf("\n", end - 1) + 1);
    const raw = src.slice(0, end) + (src[end] === "\n" ? "\n" : "");
    return {
      type: "details",
      raw,
      summary: lexer.inlineTokens(head[1]!.trim()),
      tokens: lexer.blockTokens(body.trim()),
    };
  },
};

/**
 * A section that folds away under its title. Whether it is open is each
 * reader's own view, never part of the document: it starts open, so text
 * someone else wrote into it is never hidden from the next reader.
 */
export const Details = Node.create({
  name: "details",
  group: "block",
  content: "detailsSummary detailsContent",
  defining: true,
  parseHTML: () => [{ tag: "details" }, { tag: "div[data-details]" }],
  // Open, so a print or export shows what is inside.
  renderHTML: ({ HTMLAttributes }) => ["details", { ...HTMLAttributes, open: "" }, 0],
  markdownTokenizer: detailsTokenizer,
  parseMarkdown: (token, helpers) => {
    const body = helpers.parseChildren(token.tokens ?? []);
    return helpers.createNode("details", undefined, [
      helpers.createNode(
        "detailsSummary",
        undefined,
        helpers.parseInline((token.summary as typeof token.tokens) ?? []),
      ),
      helpers.createNode(
        "detailsContent",
        undefined,
        body.length ? body : [helpers.createNode("paragraph")],
      ),
    ]);
  },
  renderMarkdown: (node, h) => {
    const [summary, content] = node.content ?? [];
    const title = summary ? h.renderChildren(summary.content ?? []).replaceAll("\n", " ") : "";
    const body = content ? h.renderChildren(content.content ?? [], "\n\n") : "";
    return `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
  },
  addKeyboardShortcuts() {
    return {
      // Enter in the title goes on into the section rather than splitting the title.
      Enter: ({ editor }) => {
        const { $from, empty } = editor.state.selection;
        if (!empty || $from.parent.type.name !== "detailsSummary") return false;
        const after = $from.after();
        return editor.commands.command(({ tr }) => {
          tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1)));
          return true;
        });
      },
    };
  },
});

/** A collapsible section's title: one line of text. */
export const DetailsSummary = Node.create({
  name: "detailsSummary",
  content: "inline*",
  defining: true,
  selectable: false,
  parseHTML: () => [{ tag: "summary" }],
  renderHTML: ({ HTMLAttributes }) => ["summary", HTMLAttributes, 0],
});

/** What a collapsible section folds away. */
export const DetailsContent = Node.create({
  name: "detailsContent",
  content: "block+",
  defining: true,
  selectable: false,
  parseHTML: () => [{ tag: "div[data-details-content]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", { ...HTMLAttributes, "data-details-content": "" }, 0],
});

/** Footnotes' definitions while one Markdown text is parsed, by label (`markdown.ts` fills it). */
export const footnoteDefinitions = new Map<string, string>();

/** A footnote's note escaped for `^[…]`, where `]` and `\` would end or escape it. */
const escapeNote = (note: string) => note.replace(/[\\\]]/g, "\\$&");

// A note of at most 1,000 characters: unbounded, a line of "^[" took seconds to read.
const INLINE_NOTE = /^\^\[((?:\\.|[^\\\]\n]){0,1000})\]/;
// A label of at most 100 characters: unbounded, a line of "[^" read to its end every time.
const REFERENCE = /^\[\^([^\]\s]{1,100})\]/;

const footnoteTokenizer: MarkdownTokenizer = {
  name: "footnote",
  level: "inline",
  start: (src) => inlineStart(src, /\^\[|\[\^/),
  tokenize: (src) => {
    // Most "^[" are no note: a "]" within reach is checked first, cheaply.
    const inline =
      src.startsWith("^[") && src.slice(2, 1_003).includes("]") ? INLINE_NOTE.exec(src) : null;
    if (inline)
      return { type: "footnote", raw: inline[0], note: inline[1]!.replace(/\\(.)/g, "$1") };
    // A reference with no definition is left as text: chat citations pasted in are not notes.
    const reference = REFERENCE.exec(src);
    const note = reference ? footnoteDefinitions.get(reference[1]!) : undefined;
    return reference && note !== undefined
      ? { type: "footnote", raw: reference[0], note }
      : undefined;
  },
};

/**
 * A footnote, sitting in the text where it is referred to and holding its own
 * note, as Google Docs keeps one; its number is its place among the others.
 */
export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      note: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-note") ?? "",
        renderHTML: (attributes) => ({ "data-note": attributes.note }),
      },
    };
  },
  parseHTML: () => [{ tag: "sup[data-footnote]" }],
  renderHTML: ({ HTMLAttributes }) => ["sup", { ...HTMLAttributes, "data-footnote": "" }],
  markdownTokenizer: footnoteTokenizer,
  parseMarkdown: (token, helpers) =>
    helpers.createNode("footnote", { note: String(token.note ?? "").trim() }),
  // People's Markdown numbers its notes (`gfm`, set by `markdown.ts`); the model's keeps each in place.
  renderMarkdown: (node) => {
    const number = (node.attrs as { gfm?: number } | undefined)?.gfm;
    const note = String(node.attrs?.note ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!note) return "";
    return number ? `[^${number}]` : `^[${escapeNote(note)}]`;
  },
});

/**
 * Numbers a tree's footnotes in order for people's Markdown, and returns
 * their notes for the definitions written at the end.
 */
export const numberFootnotes = (json: JSONContent): { json: JSONContent; notes: string[] } => {
  const notes: string[] = [];
  const walk = (node: JSONContent): JSONContent => {
    if (node.type === "footnote") {
      const note = String(node.attrs?.note ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!note) return node;
      notes.push(note);
      return { ...node, attrs: { ...node.attrs, gfm: notes.length } };
    }
    return node.content ? { ...node, content: node.content.map(walk) } : node;
  };
  return { json: walk(json), notes };
};
