import type {
  BlockContent,
  DefinitionContent,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Atlassian Document Format, the rich text Jira's v3 API reads and writes for
 * descriptions and comments. Only the shape the converters touch is typed.
 */
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}
interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export type AdfDocument = AdfNode & { type: "doc"; version: 1; content: AdfNode[] };

// Markdown to ADF. Jira validates the tree, so every node is placed only where
// ADF allows it: a code mark takes no other mark but a link, a quote holds no
// heading, and text is never empty.

const textNode = (text: string, marks: ReadonlyArray<AdfMark>): AdfNode[] =>
  text ? [{ type: "text", text, ...(marks.length ? { marks: [...marks] } : {}) }] : [];

const inline = (nodes: ReadonlyArray<PhrasingContent>, marks: ReadonlyArray<AdfMark> = []) =>
  nodes.flatMap((node): AdfNode[] => {
    switch (node.type) {
      case "text":
        return textNode(node.value, marks);
      case "strong":
        return inline(node.children, [...marks, { type: "strong" }]);
      case "emphasis":
        return inline(node.children, [...marks, { type: "em" }]);
      case "delete":
        return inline(node.children, [...marks, { type: "strike" }]);
      case "inlineCode":
        return textNode(node.value, [
          ...marks.filter((mark) => mark.type === "link"),
          { type: "code" },
        ]);
      case "link":
        return inline(node.children, [...marks, { type: "link", attrs: { href: node.url } }]);
      case "image":
        // Media needs an upload; the address stays reachable as a link.
        return textNode(node.alt || node.url, [
          ...marks,
          { type: "link", attrs: { href: node.url } },
        ]);
      case "break":
        return [{ type: "hardBreak" }];
      case "html":
        return textNode(node.value, marks);
      case "footnoteReference":
        return textNode(`[^${node.identifier}]`, marks);
      default:
        return "children" in node ? inline(node.children as PhrasingContent[], marks) : [];
    }
  });

const paragraph = (content: AdfNode[]): AdfNode => ({ type: "paragraph", content });

/** Plain text of any node, for places ADF takes nothing richer. */
const plain = (node: RootContent): string =>
  "value" in node ? node.value : "children" in node ? node.children.map(plain).join("") : "";

const table = (node: Table): AdfNode => ({
  type: "table",
  attrs: { isNumberColumnEnabled: false, layout: "default" },
  content: node.children.map((row, index) => ({
    type: "tableRow",
    content: row.children.map((cell) => ({
      type: index === 0 ? "tableHeader" : "tableCell",
      content: [paragraph(inline(cell.children))],
    })),
  })),
});

type Place = "top" | "quote" | "item";

const isTaskList = (items: ReadonlyArray<ListItem>) =>
  items.length > 0 &&
  items.every(
    (item) =>
      typeof item.checked === "boolean" &&
      item.children.length === 1 &&
      item.children[0]!.type === "paragraph",
  );

const block = (node: RootContent | BlockContent | DefinitionContent, place: Place): AdfNode[] => {
  switch (node.type) {
    case "paragraph":
      return [paragraph(inline(node.children))];
    case "heading":
      return place === "top"
        ? [{ type: "heading", attrs: { level: node.depth }, content: inline(node.children) }]
        : [paragraph(inline(node.children, [{ type: "strong" }]))];
    case "thematicBreak":
      return place === "top" ? [{ type: "rule" }] : [];
    case "blockquote":
      return place === "top"
        ? [{ type: "blockquote", content: node.children.flatMap((child) => block(child, "quote")) }]
        : node.children.flatMap((child) => block(child, place));
    case "code":
      return [
        {
          type: "codeBlock",
          ...(node.lang ? { attrs: { language: node.lang } } : {}),
          ...(node.value ? { content: [{ type: "text", text: node.value }] } : {}),
        },
      ];
    case "list": {
      if (isTaskList(node.children) && place !== "quote")
        return [
          {
            type: "taskList",
            // Task lists and items need ids unique within the document.
            attrs: { localId: crypto.randomUUID() },
            content: node.children.map((item) => ({
              type: "taskItem",
              attrs: { localId: crypto.randomUUID(), state: item.checked ? "DONE" : "TODO" },
              content: inline((item.children[0] as { children: PhrasingContent[] }).children),
            })),
          },
        ];
      return [
        {
          type: node.ordered ? "orderedList" : "bulletList",
          ...(node.ordered ? { attrs: { order: node.start ?? 1 } } : {}),
          content: node.children.map((item) => listItem(item)),
        },
      ];
    }
    case "table":
      return place === "top"
        ? [table(node)]
        : node.children.map((row) =>
            paragraph(textNode(row.children.map((cell) => plain(cell)).join(" | "), [])),
          );
    case "html":
      return [paragraph(textNode(node.value, []))];
    case "footnoteDefinition":
      return node.children.flatMap((child, index) =>
        index === 0 && child.type === "paragraph"
          ? [paragraph([...textNode(`[^${node.identifier}]: `, []), ...inline(child.children)])]
          : block(child, place),
      );
    default:
      return [];
  }
};

/** A list item's blocks; one with a checkbox outside a task list keeps it as text. */
const listItem = (item: ListItem): AdfNode => {
  const content = item.children.flatMap((child) => block(child, "item"));
  if (typeof item.checked === "boolean") {
    const box = item.checked ? "[x] " : "[ ] ";
    if (content[0]?.type === "paragraph")
      content[0] = paragraph([...textNode(box, []), ...(content[0].content ?? [])]);
    else content.unshift(paragraph(textNode(box.trim(), [])));
  }
  return { type: "listItem", content: content.length ? content : [paragraph([])] };
};

export const markdownToAdf = (markdown: string): AdfDocument => {
  const tree: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return { type: "doc", version: 1, content: tree.children.flatMap((node) => block(node, "top")) };
};

// ADF to Markdown, for the model to read. Anything unknown gives its text, so
// a node type Jira adds later degrades instead of vanishing.

const wrap = (text: string, mark: AdfMark) => {
  switch (mark.type) {
    case "strong":
      return `**${text}**`;
    case "em":
      return `*${text}*`;
    case "strike":
      return `~~${text}~~`;
    case "code":
      return `\`${text}\``;
    case "link":
      return typeof mark.attrs?.href === "string" ? `[${text}](${mark.attrs.href})` : text;
    default:
      return text;
  }
};

const attr = (node: AdfNode, key: string) =>
  typeof node.attrs?.[key] === "string" ? (node.attrs[key] as string) : null;

const inlineText = (nodes: ReadonlyArray<AdfNode> | undefined): string =>
  (nodes ?? [])
    .map((node) => {
      switch (node.type) {
        case "text": {
          const marks = node.marks ?? [];
          // Code goes innermost and a link outermost, as Markdown reads them.
          const order = (mark: AdfMark) =>
            mark.type === "code" ? 0 : mark.type === "link" ? 2 : 1;
          return marks.toSorted((a, b) => order(a) - order(b)).reduce(wrap, node.text ?? "");
        }
        case "hardBreak":
          return "\n";
        case "mention": {
          const text = attr(node, "text") ?? attr(node, "id") ?? "someone";
          return text.startsWith("@") ? text : `@${text}`;
        }
        case "emoji":
          return attr(node, "text") ?? attr(node, "shortName") ?? "";
        case "inlineCard":
          return attr(node, "url") ?? "";
        case "date": {
          const stamp = Number(node.attrs?.timestamp);
          return Number.isFinite(stamp) ? new Date(stamp).toISOString().slice(0, 10) : "";
        }
        case "status":
          return `[${attr(node, "text") ?? ""}]`;
        default:
          return inlineText(node.content) || (node.text ?? "");
      }
    })
    .join("");

const indent = (text: string, by: string) =>
  text
    .split("\n")
    .map((line, index) => (index === 0 || !line ? line : `${by}${line}`))
    .join("\n");

/** Items read as a tight list: a nested list follows its line directly. */
const item = (marker: string, content: ReadonlyArray<AdfNode> | undefined) =>
  `${marker}${indent(blocks(content, "\n"), " ".repeat(marker.length))}`;

const cell = (node: AdfNode) => blocks(node.content).replace(/\n+/g, " ").replace(/\|/g, "\\|");

const blockText = (node: AdfNode): string => {
  switch (node.type) {
    case "paragraph":
      return inlineText(node.content);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.level) || 1)} ${inlineText(node.content)}`;
    case "bulletList":
      return (node.content ?? []).map((entry) => item("- ", entry.content)).join("\n");
    case "orderedList": {
      const start = Number(node.attrs?.order) || 1;
      return (node.content ?? [])
        .map((entry, index) => item(`${start + index}. `, entry.content))
        .join("\n");
    }
    case "taskList":
      return (node.content ?? [])
        .map((entry) =>
          entry.type === "taskItem"
            ? `- [${entry.attrs?.state === "DONE" ? "x" : " "}] ${inlineText(entry.content)}`
            : indent(blockText(entry), "  "),
        )
        .join("\n");
    case "decisionList":
      return (node.content ?? []).map((entry) => `- ${inlineText(entry.content)}`).join("\n");
    case "codeBlock":
      return `\`\`\`${attr(node, "language") ?? ""}\n${inlineText(node.content)}\n\`\`\``;
    case "blockquote":
      return blocks(node.content)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "panel": {
      const kind = attr(node, "panelType") ?? "info";
      return `> **${kind[0]!.toUpperCase()}${kind.slice(1)}:** ${indent(blocks(node.content), "> ")}`;
    }
    case "expand":
    case "nestedExpand":
      return `**${attr(node, "title") ?? "Details"}**\n\n${blocks(node.content)}`;
    case "rule":
      return "---";
    case "table": {
      const rows = (node.content ?? []).map(
        (row) => `| ${(row.content ?? []).map(cell).join(" | ")} |`,
      );
      if (rows.length === 0) return "";
      const columns = node.content?.[0]?.content?.length ?? 1;
      return [rows[0], `|${" --- |".repeat(columns)}`, ...rows.slice(1)].join("\n");
    }
    case "mediaSingle":
    case "mediaGroup":
      return "[attachment]";
    case "blockCard":
    case "embedCard":
      return attr(node, "url") ?? "";
    default:
      return node.content?.some((child) => child.type === "text")
        ? inlineText(node.content)
        : blocks(node.content) || (node.text ?? "");
  }
};

const blocks = (nodes: ReadonlyArray<AdfNode> | undefined, separator = "\n\n") =>
  (nodes ?? [])
    .map(blockText)
    .filter((text) => text !== "")
    .join(separator);

/** Markdown for the model; null or a non-document reads as empty. */
export const adfToMarkdown = (document: unknown): string => {
  if (typeof document === "string") return document;
  if (!document || typeof document !== "object" || !("content" in document)) return "";
  return blocks((document as AdfNode).content);
};
