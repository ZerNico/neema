import type { Node } from "@tiptap/pm/model";
import { blockIdOf, isBlock } from "./block-ids.ts";
import { toMarkdown } from "./markdown.ts";

/** One emitted block and the fingerprint of what the model was shown for it. */
export interface SeenBlock {
  id: string;
  hash: string;
}
export interface BlockView {
  xml: string;
  /** Every block the view showed in full, so an edit can tell what the model saw. */
  seen: SeenBlock[];
  /** Where a windowed view continues; absent once it reached the end. */
  next?: { fromBlock: string; fromCharacter?: number };
}

/**
 * A short fingerprint of a block's whole subtree, attributes included, so a
 * ticked box, a heading level or a planned section's intent all count as a
 * change. Server-side only: the model never sees or sends it.
 */
export const blockHash = (node: Node) => {
  const text = JSON.stringify(node.toJSON());
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const escapeText = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string) => escapeText(text).replaceAll('"', "&quot;");
const attributes = (values: Record<string, string | number | boolean | null | undefined>) =>
  Object.entries(values)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ` ${key}="${escapeAttribute(String(value))}"`)
    .join("");

/**
 * A paragraph's or heading's text as inline Markdown, what the model also
 * writes. The serializer already writes `&` and `<` in text as entities, so
 * it goes into the XML as it is.
 */
const inline = (node: Node) =>
  toMarkdown(
    node.type.schema.node("doc", null, [node.type.schema.node("paragraph", null, node.content)]),
  );

/** The open tag's name for a block, or null for one drawn through its parent. */
const TAGS: Record<string, string> = {
  paragraph: "p",
  blockquote: "quote",
  codeBlock: "code",
  bulletList: "ul",
  orderedList: "ol",
  taskList: "tasks",
  listItem: "li",
  taskItem: "task",
  table: "table",
  horizontalRule: "hr",
  pending: "pending",
};

/**
 * A block as XML. Text is inline Markdown; a list item holding one paragraph
 * shows as one element under the item's ID. Every block drawn in full is
 * added to `seen`.
 */
const render = (node: Node, seen: SeenBlock[]): string => {
  const id = blockIdOf(node);
  if (id) seen.push({ id, hash: blockHash(node) });
  const name = node.type.name;
  const tag = name === "heading" ? `h${node.attrs.level as number}` : (TAGS[name] ?? name);
  const head = (extra: Record<string, string | number | boolean | null | undefined> = {}) =>
    `<${tag}${attributes({ id, ...extra })}`;
  switch (name) {
    case "paragraph":
    case "heading":
      return `${head()}>${inline(node)}</${tag}>`;
    case "codeBlock":
      return `${head({ lang: node.attrs.language as string | null })}>${escapeText(node.textContent)}</${tag}>`;
    case "table":
      return `${head()}>\n${toMarkdown(node.type.schema.node("doc", null, [node]))}\n</${tag}>`;
    case "horizontalRule":
      return `${head()}/>`;
    case "pending":
      return `${head({ intent: node.attrs.intent as string })}/>`;
    case "listItem":
    case "taskItem": {
      const extra = name === "taskItem" ? { checked: Boolean(node.attrs.checked) } : {};
      const only = node.childCount === 1 ? node.firstChild : null;
      if (only?.type.name === "paragraph") {
        // The paragraph's own ID is internal: the item is what the model points at.
        const paragraphId = blockIdOf(only);
        if (paragraphId) seen.push({ id: paragraphId, hash: blockHash(only) });
        return `${head(extra)}>${inline(only)}</${tag}>`;
      }
      return `${head(extra)}>${children(node, seen)}</${tag}>`;
    }
    case "orderedList":
      return `${head({ start: node.attrs.start === 1 ? null : (node.attrs.start as number) })}>${children(node, seen)}</${tag}>`;
    default:
      return `${head()}>${children(node, seen)}</${tag}>`;
  }
};
const children = (node: Node, seen: SeenBlock[]) => {
  const parts: string[] = [];
  node.forEach((child) => {
    if (isBlock(child) || child.isBlock) parts.push(render(child, seen));
  });
  return parts.join("");
};

/**
 * The document as the model reads it: one element per top-level block, each
 * with its ID, bounded by `budget` characters. A window starts at
 * `fromBlock`; blocks skipped either side show as a `<gap/>`. A single block
 * larger than the budget is cut, marked `truncated`, and continues from
 * `fromCharacter`; it is not added to `seen`, so it cannot be replaced
 * before the model has read it whole.
 */
export const blockView = (
  doc: Node,
  options: { budget: number; fromBlock?: string; fromCharacter?: number },
): BlockView => {
  const blocks: Node[] = [];
  doc.forEach((child) => blocks.push(child));
  const start = options.fromBlock
    ? Math.max(
        0,
        blocks.findIndex((block) => blockIdOf(block) === options.fromBlock),
      )
    : 0;
  const seen: SeenBlock[] = [];
  const lines: string[] = [];
  if (start > 0) lines.push(`<gap blocks="${start}"/>`);
  let used = 0;
  let index = start;
  for (; index < blocks.length; index++) {
    const block = blocks[index]!;
    const own: SeenBlock[] = [];
    const xml = render(block, own);
    const fromCharacter = index === start ? (options.fromCharacter ?? 0) : 0;
    if (fromCharacter === 0 && used + xml.length <= options.budget) {
      lines.push(xml);
      seen.push(...own);
      used += xml.length;
      continue;
    }
    // Room left for part of it only when nothing else fits: one oversized block, cut.
    if (lines.length > (start > 0 ? 1 : 0) && fromCharacter === 0) break;
    const id = blockIdOf(block);
    const piece = xml.slice(fromCharacter, fromCharacter + options.budget);
    const done = fromCharacter + piece.length >= xml.length;
    lines.push(
      // A slice of the block's own XML, already escaped; it may stop inside a tag.
      `<part${attributes({ of: id, from: fromCharacter, truncated: done ? null : true })}>${piece}</part>`,
    );
    if (!done)
      return {
        xml: lines.join("\n"),
        seen,
        next: { fromBlock: id ?? "", fromCharacter: fromCharacter + piece.length },
      };
    index++;
    break;
  }
  const rest = blocks.length - index;
  if (rest > 0) lines.push(`<gap blocks="${rest}"/>`);
  const nextBlock = blocks[index];
  const nextId = nextBlock ? blockIdOf(nextBlock) : null;
  return {
    xml: lines.join("\n"),
    seen,
    ...(rest > 0 && nextId ? { next: { fromBlock: nextId } } : {}),
  };
};
