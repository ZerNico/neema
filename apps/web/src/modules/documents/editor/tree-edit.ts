import { Fragment, Slice, type Mark, type Node } from "@tiptap/pm/model";
import { Transform } from "@tiptap/pm/transform";
import { BLOCK_ID, blockIdOf, ensureIds, findBlocks, isBlock, withFreshIds } from "./block-ids.ts";
import { withoutComments } from "./comments.ts";
import { parseMarkdown, toModelMarkdown } from "./markdown.ts";
import { PENDING_INTENT_CHARS } from "./pending.ts";
import { blockHash } from "./tree.ts";

/** One change the model asks for, aimed at blocks by ID or at text inside one block. */
export type TreeEdit =
  | {
      kind: "blocks";
      target: string;
      /** The last block of a range, a sibling of `target`. */
      through?: string;
      position: "replace" | "before" | "after";
      /** Markdown, or nothing to delete the range. */
      content?: string;
      /** A planned section to put there instead of content. */
      pending?: string;
    }
  | { kind: "find"; target?: string; find: string; content: string };

export type EditRefusal = {
  outcome: "not_found" | "ambiguous" | "conflict" | "invalid" | "no_match";
  message: string;
};

/** What the model was shown of each block, by ID; an edit may only replace blocks shown as they are. */
export type SeenBlocks = ReadonlyMap<string, string>;

const refuse = (outcome: EditRefusal["outcome"], message: string): EditRefusal => ({
  outcome,
  message,
});

/** Markdown as a tree, or null where it cannot form a valid one. */
const parsedOrNull = (markdown: string) => {
  try {
    return parseMarkdown(markdown);
  } catch {
    return null;
  }
};

const UNREADABLE = "That Markdown cannot be read as a document.";

/** One block by ID, or why it cannot be used. */
const locate = (doc: Node, id: string) => {
  const found = findBlocks(doc, id);
  if (found.length === 0)
    return refuse("not_found", `No block ${id.slice(0, 40)} in this document.`);
  if (found.length > 1)
    return refuse(
      "ambiguous",
      `Block ${id.slice(0, 40)} occurs more than once; read the document again.`,
    );
  const { node, position } = found[0]!;
  const $position = doc.resolve(position);
  return {
    node,
    position,
    parent: $position.parent,
    index: $position.index(),
    start: $position.start(),
  };
};

/** Where the model can place content without naming a block: the document's ends. */
export const DOCUMENT_ENDS = ["start", "end"] as const;

/**
 * A placement the model can name without reading there, as a block and a
 * side: `start` and `end` for the document's ends, and position `end` on a
 * heading for the end of its section (before the next heading as high or
 * higher). Anything else is returned as it is.
 */
export const placement = (
  doc: Node,
  target: string,
  position: "replace" | "before" | "after" | "end",
): { target: string; position: "replace" | "before" | "after" } => {
  const blocks: Node[] = [];
  doc.forEach((block) => blocks.push(block));
  const first = blocks[0] ? blockIdOf(blocks[0]) : null;
  const last = blocks.at(-1) ? blockIdOf(blocks.at(-1)!) : null;
  if (target === "end" && last) return { target: last, position: "after" };
  if (target === "start" && first) return { target: first, position: "before" };
  if (position !== "end") return { target, position };
  const index = blocks.findIndex((block) => blockIdOf(block) === target);
  const heading = blocks[index];
  if (index === -1 || heading?.type.name !== "heading") return { target, position: "after" };
  const level = Number(heading.attrs.level) || 1;
  let end = index;
  while (
    end + 1 < blocks.length &&
    !(blocks[end + 1]!.type.name === "heading" && Number(blocks[end + 1]!.attrs.level) <= level)
  )
    end++;
  return { target: blockIdOf(blocks[end]!) ?? target, position: "after" };
};

/** The blocks a `blocks` edit covers, as a sibling range in one parent. */
export const resolveRange = (doc: Node, target: string, through?: string) => {
  const first = locate(doc, target);
  if ("outcome" in first) return first;
  if (!through || through === target)
    return {
      ...first,
      from: first.position,
      to: first.position + first.node.nodeSize,
      startIndex: first.index,
      endIndex: first.index + 1,
    };
  const last = locate(doc, through);
  if ("outcome" in last) return last;
  if (last.parent !== first.parent)
    return refuse(
      "invalid",
      "target and through must be blocks side by side in the same list or level.",
    );
  const [a, b] = first.position <= last.position ? [first, last] : [last, first];
  return {
    ...a,
    from: a.position,
    to: b.position + b.node.nodeSize,
    startIndex: a.index,
    endIndex: b.index + 1,
  };
};
export type BlockRange = Exclude<ReturnType<typeof resolveRange>, EditRefusal>;

/** Every block the model must have seen as it is now before it may replace or delete the range. */
export const checkSeen = (range: BlockRange, seen: SeenBlocks | null): EditRefusal | null => {
  if (!seen) return null;
  for (let index = range.startIndex; index < range.endIndex; index++) {
    const node = range.parent.child(index);
    const id = blockIdOf(node);
    const shown = id ? seen.get(id) : undefined;
    if (shown === undefined)
      return refuse(
        "conflict",
        "That range has a block you have not read. Read the document, then aim the change again.",
      );
    if (shown !== blockHash(node))
      return refuse(
        "conflict",
        "Someone changed that block after you read it. Its current text is in the trailing application data; keep their change.",
      );
  }
  return null;
};

/**
 * Markdown as nodes that fit `parent` between `startIndex` and `endIndex`.
 * Aimed at a list item, a Markdown list's items are used; aimed at a block
 * inside an item, its blocks are.
 */
export const fitBlocks = (
  parent: Node,
  startIndex: number,
  endIndex: number,
  markdown: string,
): Fragment | EditRefusal => {
  const parsed = parsedOrNull(markdown);
  if (!parsed) return refuse("invalid", UNREADABLE);
  const schema = parent.type.schema;
  // Built with the document's schema, which may be another instance of the same one.
  let content = Fragment.fromJSON(schema, parsed.content.toJSON());
  for (let depth = 0; depth < 3; depth++) {
    if (parent.canReplace(startIndex, endIndex, content)) return content;
    // A list where items belong: take its items.
    if (content.childCount === 1 && content.firstChild!.type.spec.group?.includes("list"))
      content = content.firstChild!.content;
    else break;
  }
  if (parent.canReplace(startIndex, endIndex, content)) return content;
  return refuse(
    "invalid",
    parent.type.name === "doc"
      ? "That Markdown does not form whole blocks."
      : `That Markdown does not fit inside a ${parent.type.name}: write ${parent.type.name === "bulletList" || parent.type.name === "orderedList" || parent.type.name === "taskList" ? "list items" : "blocks that belong there"}.`,
  );
};

const pendingNode = (doc: Node, intent: string) =>
  doc.type.schema.nodes.pending!.create({ intent: intent.slice(0, PENDING_INTENT_CHARS) });

/** Deletes `from`..`to`, taking an emptied list or quote with it. */
const deleteRange = (tr: Transform, from: number, to: number) => {
  let start = from;
  let end = to;
  for (;;) {
    const $start = tr.doc.resolve(start);
    const parent = $start.parent;
    const index = $start.index();
    const endIndex = tr.doc.resolve(end).index();
    if ($start.depth === 0 || parent.canReplace(index, endIndex === index ? index + 1 : endIndex))
      break;
    start = $start.before();
    end = $start.after();
  }
  tr.delete(start, end);
};

/** Text of a block as the model reads it: inline Markdown, or a code block's raw text. */
const blockText = (node: Node) =>
  node.type.name === "codeBlock"
    ? node.textContent
    : toModelMarkdown(
        node.type.schema.node("doc", null, [
          node.type.schema.node("paragraph", null, node.content),
        ]),
      );

const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

/** `text` occurs exactly once across these blocks: the block and where. */
const findOnce = (scope: Node, offset: number, text: string) => {
  const hits: { node: Node; position: number; at: number }[] = [];
  const check = (node: Node, position: number) => {
    const source = blockText(node);
    for (let at = source.indexOf(text); at !== -1; at = source.indexOf(text, at + 1))
      hits.push({ node, position, at });
  };
  // Aimed at a paragraph itself, rather than at something holding paragraphs.
  if (scope.isTextblock) check(scope, offset - 1);
  else
    scope.descendants((node, position) => {
      if (!node.isTextblock) return true;
      check(node, offset + position);
      return false;
    });
  return hits;
};

/**
 * One edit applied to `doc`, as the steps that make it, or why it cannot be.
 * `seen` guards a replace or delete; null means the caller vouches for it.
 * New blocks get IDs; a same-type single block replaced in place keeps its
 * own, so nearby cursors and anchors stay with it.
 */
export const applyTreeEdit = (
  doc: Node,
  edit: TreeEdit,
  seen: SeenBlocks | null,
): { tr: Transform; touched: string[] } | EditRefusal => {
  const tr = new Transform(doc);
  if (edit.kind === "find") {
    if (!edit.find) return refuse("invalid", "find must not be empty.");
    let scope = doc;
    let offset = 0;
    if (edit.target) {
      const target = locate(doc, edit.target);
      if ("outcome" in target) return target;
      scope = target.node;
      offset = target.position + 1;
    }
    // The model quotes text as its XML view shows it, entities included.
    let find = edit.find;
    let replacement = edit.content;
    let hits = findOnce(scope, offset, find);
    if (hits.length === 0 && unescapeXml(find) !== find) {
      find = unescapeXml(find);
      replacement = unescapeXml(replacement);
      hits = findOnce(scope, offset, find);
    }
    if (hits.length === 0)
      return refuse(
        "no_match",
        edit.find.includes("\n")
          ? "find matches text inside one block; aim at blocks by ID to change more than one."
          : "That text is not in the document as you wrote it. Copy it from the current content.",
      );
    if (hits.length > 1)
      return refuse(
        "ambiguous",
        `That text occurs ${hits.length} times; name the block with target or include more of it.`,
      );
    const { node, position, at } = hits[0]!;
    const source = blockText(node);
    const next = source.slice(0, at) + replacement + source.slice(at + find.length);
    if (next === source) return { tr, touched: [] };
    let content: Fragment;
    if (node.type.name === "codeBlock")
      content = next ? Fragment.from(doc.type.schema.text(next)) : Fragment.empty;
    else {
      const parsed = parsedOrNull(next);
      if (!parsed) return refuse("invalid", UNREADABLE);
      const first = parsed.firstChild;
      if (parsed.childCount > 1 || (first && !first.isTextblock))
        return refuse(
          "invalid",
          "find replaces text within one block; its new text must stay one paragraph.",
        );
      content = first ? Fragment.fromJSON(doc.type.schema, first.content.toJSON()) : Fragment.empty;
    }
    // Only the part of the block that differs, so the rest of its text keeps
    // its place, and comments on it stay: the model never saw their marks.
    const current = withoutComments(node.content);
    const start = current.findDiffStart(content);
    if (start !== null) {
      const end = current.findDiffEnd(content)!;
      let endA = end.a;
      let endB = end.b;
      const overlap = start - Math.min(endA, endB);
      if (overlap > 0) {
        endA += overlap;
        endB += overlap;
      }
      const from = position + 1 + start;
      // Comments on the words being replaced move onto the words replacing them.
      const comments = new Set<Mark>();
      doc.nodesBetween(from, position + 1 + endA, (child) => {
        for (const mark of child.marks) if (mark.type.name === "comment") comments.add(mark);
      });
      tr.replace(from, position + 1 + endA, new Slice(content.cut(start, endB), 0, 0));
      for (const mark of comments) tr.addMark(from, position + 1 + endB, mark);
    }
    const id = blockIdOf(node);
    return { tr: ensureIds(tr), touched: id ? [id] : [] };
  }

  const range = resolveRange(doc, edit.target, edit.through);
  if ("outcome" in range) return range;
  if (edit.position === "replace") {
    const stale = checkSeen(range, seen);
    if (stale) return stale;
  }
  const at =
    edit.position === "before"
      ? {
          from: range.from,
          to: range.from,
          startIndex: range.startIndex,
          endIndex: range.startIndex,
        }
      : edit.position === "after"
        ? { from: range.to, to: range.to, startIndex: range.endIndex, endIndex: range.endIndex }
        : range;
  let content: Fragment;
  if (edit.pending !== undefined) content = Fragment.from(pendingNode(doc, edit.pending));
  else if (edit.content?.trim()) {
    const fitted = fitBlocks(range.parent, at.startIndex, at.endIndex, edit.content);
    if ("outcome" in fitted) return fitted;
    content = fitted;
  } else if (edit.position === "replace") {
    deleteRange(tr, range.from, range.to);
    return { tr: ensureIds(tr), touched: [] };
  } else return refuse("invalid", "Give content or pending to insert.");

  // A single block replaced by one of the same type keeps its ID.
  const keep =
    edit.position === "replace" &&
    range.endIndex - range.startIndex === 1 &&
    content.childCount === 1
      ? range.parent.child(range.startIndex)
      : null;
  if (keep && content.firstChild!.type === keep.type)
    content = Fragment.from(
      content.firstChild!.type.create(
        { ...content.firstChild!.attrs, [BLOCK_ID]: blockIdOf(keep) },
        content.firstChild!.content,
        content.firstChild!.marks,
      ),
    );
  tr.replaceWith(at.from, at.to, withFreshIds(doc, content));
  ensureIds(tr);
  const touched: string[] = [];
  const inserted = tr.doc.slice(at.from, at.from + content.size).content;
  inserted.forEach((node) => {
    const id = blockIdOf(node);
    if (id && isBlock(node)) touched.push(id);
  });
  return { tr, touched };
};
