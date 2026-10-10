import { Mark } from "@tiptap/core";
import { Fragment, type Node } from "@tiptap/pm/model";
import { blockIdOf, findBlocks, isBlock } from "./block-ids.ts";

/**
 * The text a comment thread is about. The thread itself lives in its own
 * table; the mark only anchors it, so it travels with the text through every
 * step like bold does, and goes when that text is deleted. Writes no Markdown.
 */
export const CommentMark = Mark.create({
  name: "comment",
  inclusive: false,
  // Threads may overlap.
  excludes: "",
  addAttributes() {
    return {
      thread: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-comment"),
        renderHTML: (attributes) => ({ "data-comment": attributes.thread }),
      },
    };
  },
  parseHTML: () => [{ tag: "span[data-comment]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", HTMLAttributes, 0],
  renderMarkdown: (node, h) => (node.content ? h.renderChildren(node.content) : ""),
});

export interface CommentAnchor {
  from: number;
  to: number;
  /** The commented text, as one line. */
  text: string;
  /** The innermost block it starts in. */
  blockId: string | null;
}

/** Where each thread's text is now, by thread ID. A thread whose text was deleted has none. */
export const commentAnchors = (doc: Node) => {
  const anchors = new Map<string, CommentAnchor>();
  let block: string | null = null;
  doc.descendants((node, position) => {
    if (isBlock(node)) block = blockIdOf(node) ?? block;
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment" || typeof mark.attrs.thread !== "string") continue;
      const end = position + node.nodeSize;
      const found = anchors.get(mark.attrs.thread);
      if (found) {
        found.to = end;
        found.text += node.text;
      } else
        anchors.set(mark.attrs.thread, {
          from: position,
          to: end,
          text: node.text ?? "",
          blockId: block,
        });
    }
    return false;
  });
  return anchors;
};

/**
 * `content` without comment marks, for comparing with text the model rewrote
 * without seeing them. Rebuilt so text left with the same marks joins again.
 */
export const withoutComments = (content: Fragment): Fragment => {
  const nodes: Node[] = [];
  content.forEach((child) =>
    nodes.push(
      child.isText ? child.mark(child.marks.filter((mark) => mark.type.name !== "comment")) : child,
    ),
  );
  return Fragment.fromArray(nodes);
};

/**
 * Where `quote` sits inside the block `blockId`, as text a comment can mark:
 * its first text block's whole text without a quote. Text is matched as the
 * reader sees it, chips by the text they show.
 */
export const quoteRange = (doc: Node, blockId: string, quote: string | undefined) => {
  const blocks = findBlocks(doc, blockId);
  if (blocks.length !== 1) return { refused: "not_found" as const };
  const { node: block, position } = blocks[0]!;
  const hits: { from: number; to: number }[] = [];
  const search = (textblock: Node, start: number) => {
    // Each character of the block's text, with the document position it came from.
    const places: number[] = [];
    textblock.forEach((child, offset) => {
      const text = child.isText ? child.text! : child.textContent;
      for (let index = 0; index < text.length; index++)
        places.push(start + offset + (child.isText ? index : 0));
    });
    if (!quote) {
      if (textblock.content.size) hits.push({ from: start, to: start + textblock.content.size });
      return;
    }
    const text = textblock.textContent;
    for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) {
      const last = places[at + quote.length - 1]!;
      const lastNode = doc.resolve(last).nodeAfter;
      hits.push({
        from: places[at]!,
        to: last + (lastNode?.isText ? 1 : (lastNode?.nodeSize ?? 1)),
      });
    }
  };
  if (block.isTextblock) search(block, position + 1);
  else
    block.descendants((child, offset) => {
      if (!child.isTextblock) return true;
      if (!quote && hits.length) return false;
      search(child, position + 1 + offset + 1);
      return false;
    });
  if (!hits.length) return { refused: quote ? ("no_match" as const) : ("not_found" as const) };
  if (quote && hits.length > 1) return { refused: "ambiguous" as const };
  return hits[0]!;
};

/** Open threads whose text `before` held and `after` no longer does. */
export const detachedThreads = (before: Node, after: Node, open: ReadonlySet<string>) => {
  const kept = commentAnchors(after);
  return [...commentAnchors(before).keys()].filter((id) => open.has(id) && !kept.has(id));
};
