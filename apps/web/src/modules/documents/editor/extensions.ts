import type { AnyExtension, JSONContent, MarkdownTokenizer } from "@tiptap/core";
import { CodeBlock } from "@tiptap/extension-code-block";
import { Image } from "@tiptap/extension-image";
import { OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import {
  renderTableToMarkdown,
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { UniqueID } from "@tiptap/extension-unique-id";
import { Markdown } from "@tiptap/markdown";
import { isolatedMarked } from "./isolated-marked.ts";
import { StarterKit } from "@tiptap/starter-kit";
import { BLOCK_ID, BLOCK_TYPES, newBlockId } from "./block-ids.ts";
import { Callout, Details, DetailsContent, DetailsSummary, Footnote } from "./blocks.ts";
import { DocumentUnderline, Highlight } from "./marks.ts";
import { DateChip, PersonMention } from "./chips.ts";
import { DocumentBlockMath, DocumentInlineMath } from "./math.ts";
import { CommentMark } from "./comments.ts";
import { Pending } from "./pending.ts";
import { SheetEmbed } from "./sheet-embed.ts";
import { isRemoteChange } from "./remote.ts";

/** Addresses a link may point at; anything else (javascript:, data:) is refused. */
export const SAFE_LINK = /^(?:https?:|mailto:)/i;

/** A run of backticks longer than any inside `text`, so the text cannot close it. */
export const fenceFor = (text: string, shortest: number) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(shortest, longest + 1));
};

/** Where a list can end: a blank line, then a line neither indented nor a list item. */
const LIST_EXTENT = /\n\n(?![ \t]|[-+*][ \t]|\d+[.)][ \t])/;

/**
 * Upstream's list tokenizers split the whole rest of the document into lines
 * at every block they are asked about, which made parsing quadratic: two
 * seconds at the size cap. They now see only where a list can start, and
 * only as far as it can reach.
 */
const bounded = (tokenizer: MarkdownTokenizer, item: RegExp): MarkdownTokenizer => ({
  ...tokenizer,
  tokenize: (src, tokens, lexer) => {
    if (!item.test(src)) return undefined;
    const end = src.search(LIST_EXTENT);
    return tokenizer.tokenize(end === -1 ? src : src.slice(0, end + 1), tokens, lexer);
  },
});

/** Upstream's table start does the same; only the next two lines decide it. */
const tableTokenizer = Table.config.markdownTokenizer!;
const tableStart = (src: string) => {
  const start = tableTokenizer.start;
  if (typeof start !== "function") return -1;
  const first = src.indexOf("\n");
  const second = first === -1 ? -1 : src.indexOf("\n", first + 1);
  return start(second === -1 ? src : src.slice(0, second));
};

const DocumentOrderedList = OrderedList.extend({
  markdownTokenizer: bounded(OrderedList.config.markdownTokenizer!, /^[ \t]*\d+[.)][ \t]/),
  addAttributes() {
    return {
      ...this.parent?.(),
      // Upstream reads a pasted `start` with parseInt: "" or "x" gives NaN,
      // which the server refuses as no list start, stalling every edit after it.
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const start = Number.parseInt(element.getAttribute("start") ?? "", 10);
          return Number.isInteger(start) && start >= 0 ? start : 1;
        },
      },
    };
  },
});
const DocumentTaskList = TaskList.extend({
  markdownTokenizer: bounded(TaskList.config.markdownTokenizer!, /^[ \t]*[-+*][ \t]+\[[ xX]\]/),
});

/** Upstream always fences with three backticks, which a fence inside the code ends. */
export const DocumentCodeBlock = CodeBlock.extend({
  // Code takes no formatting, but it can be commented on.
  marks: "comment",
  renderMarkdown: (node, h) => {
    const text = node.content ? h.renderChildren(node.content) : "";
    const fence = fenceFor(text, 3);
    return `${fence}${(node.attrs?.language as string | null) ?? ""}\n${text}\n${fence}`;
  },
});

/** A Markdown table's first row is its header, so a table's first row is always header cells. */
const withHeaderRow = (table: JSONContent): JSONContent => {
  const [first, ...rest] = table.content ?? [];
  if (!first?.content?.some((cell) => cell.type === "tableCell")) return table;
  const header = {
    ...first,
    content: first.content.map((cell) => ({ ...cell, type: "tableHeader" })),
  };
  return { ...table, content: [header, ...rest] };
};

// Upstream leaves a cell's `|` bare, which splits the cell on the next read,
// and pads the table with blank lines the block separator already adds.
const DocumentTable = Table.extend({
  markdownTokenizer: { ...tableTokenizer, start: tableStart },

  renderMarkdown: (node, h) => {
    const cells = Object.assign(Object.create(h) as typeof h, {
      renderChildren: (...args: Parameters<typeof h.renderChildren>) =>
        h.renderChildren(...args).replace(/(?<!\\)\|/g, "\\|"),
    });
    // Markdown needs a header line. A table without a header row (the tree
    // allows one) writes its first row there rather than a blank one, which
    // would come back as a header nobody put there.
    return renderTableToMarkdown(withHeaderRow(node), cells).trim();
  },
});

/**
 * The one document schema, built identically in the browser editor and on the
 * server, which refuses any step that does not fit it. Markdown is an export
 * and what the model writes, not the limit: a planned section has none.
 */
export const documentExtensions: AnyExtension[] = [
  StarterKit.configure({
    // It appends an empty paragraph whenever a document opens, which under
    // collab is a step: opening would count as editing, and a viewer could not.
    trailingNode: false,
    // Ours, written as <u> (`marks.ts`).
    underline: false,
    codeBlock: false,
    orderedList: false,
    link: {
      openOnClick: false,
      autolink: true,
      isAllowedUri: (url) => SAFE_LINK.test(url),
    },
  }),
  DocumentCodeBlock,
  DocumentUnderline,
  Highlight,
  // Markdown images sit inside text; a block image would split the paragraph.
  Image.configure({ inline: true }),
  DocumentOrderedList,
  DocumentTaskList,
  TaskItem.configure({ nested: true }),
  // The wrapper scrolls a wide table sideways inside its rounded frame.
  DocumentTable.configure({ resizable: false, renderWrapper: true }),
  TableRow,
  TableHeader,
  TableCell,
  Pending,
  DocumentInlineMath,
  DocumentBlockMath,
  DateChip,
  PersonMention,
  Callout,
  Details,
  DetailsSummary,
  DetailsContent,
  Footnote,
  SheetEmbed,
  CommentMark,
  // Steps received from the server already carry the IDs their sender gave.
  UniqueID.configure({
    attributeName: BLOCK_ID,
    types: [...BLOCK_TYPES],
    generateID: newBlockId,
    filterTransaction: (transaction) => !isRemoteChange(transaction),
  }),
  Markdown.configure({ marked: isolatedMarked() }),
];
