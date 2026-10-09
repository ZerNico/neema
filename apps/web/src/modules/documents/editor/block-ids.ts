import { Fragment, Mark, type Node } from "@tiptap/pm/model";
import type { Transform } from "@tiptap/pm/transform";

/** The attribute a block's permanent ID lives in. */
export const BLOCK_ID = "id";

/** The nodes the model can point at. Table rows and cells are reached through their table. */
export const BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "taskList",
  "listItem",
  "taskItem",
  "table",
  "horizontalRule",
  "pending",
] as const;
const blockTypes = new Set<string>(BLOCK_TYPES);
export const isBlock = (node: Node) => blockTypes.has(node.type.name);

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/**
 * Eight characters: short, since the model reads one per block, and long
 * enough that two minted in one document all but never meet (one in about
 * two hundred thousand at the block cap). The rare repeat is repaired anyway.
 */
export const newBlockId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => ALPHABET[byte % 36]).join("");

export const blockIdOf = (node: Node): string | null => {
  const id: unknown = node.attrs[BLOCK_ID];
  return typeof id === "string" && id ? id : null;
};

/**
 * Gives every block an ID it lacks and a fresh one to every repeat after the
 * first. Editors mint IDs for what people type; this covers what the server
 * builds from Markdown, and repeats an undo or a stray client brought back.
 */
export const ensureIds = <T extends Transform>(tr: T, mint: () => string = newBlockId): T => {
  const seen = new Set<string>();
  const missing: number[] = [];
  tr.doc.descendants((node, position) => {
    if (!isBlock(node)) return true;
    const id = blockIdOf(node);
    if (id && !seen.has(id)) seen.add(id);
    else missing.push(position);
    return true;
  });
  for (const position of missing) {
    let id = mint();
    while (seen.has(id)) id = mint();
    seen.add(id);
    tr.setNodeAttribute(position, BLOCK_ID, id);
  }
  return tr;
};

/** Every block carrying `id`, in document order, with where it starts. */
export const findBlocks = (doc: Node, id: string) => {
  const found: { node: Node; position: number }[] = [];
  doc.descendants((node, position) => {
    if (isBlock(node) && blockIdOf(node) === id) found.push({ node, position });
    return true;
  });
  return found;
};

/** Equal but for block IDs: what a Markdown round trip of an unchanged block gives. */
const sameIgnoringIds = (a: Node, b: Node): boolean => {
  if (a.type !== b.type || !Mark.sameSet(a.marks, b.marks)) return false;
  for (const key of Object.keys(a.attrs))
    if (key !== BLOCK_ID && a.attrs[key] !== b.attrs[key]) return false;
  if (a.isText) return a.text === b.text;
  if (a.childCount !== b.childCount) return false;
  for (let index = 0; index < a.childCount; index++)
    if (!sameIgnoringIds(a.child(index), b.child(index))) return false;
  return true;
};

/** Markdown cannot hold one, so a tree built from Markdown never has it. */
const isEmptyParagraph = (node: Node) => node.type.name === "paragraph" && node.childCount === 0;

/**
 * `next`, a tree built from Markdown with no IDs, given the IDs of the blocks
 * in `current` it corresponds to: unchanged blocks at either end, and in the
 * changed middle, blocks of the same type in the same place. Compared after
 * this, only blocks that really changed differ, so an edit keeps every other
 * block's identity and anyone's cursor in it. Empty paragraphs, which
 * Markdown drops, are kept wherever the blocks around them did not change:
 * one may be where someone is about to type.
 */
export const adoptIds = (current: Node, next: Node): Node => {
  if (next.isText || next.isLeaf) return withId(current, next, next.content);
  // Non-empty children of `current`, and the empty paragraphs before each (the last: after all).
  const before: Node[] = [];
  const empties: Node[][] = [[]];
  current.forEach((child) => {
    if (isEmptyParagraph(child)) empties.at(-1)!.push(child);
    else {
      before.push(child);
      empties.push([]);
    }
  });
  const after: Node[] = [];
  next.forEach((child) => after.push(child));
  let head = 0;
  while (
    head < before.length &&
    head < after.length &&
    sameIgnoringIds(before[head]!, after[head]!)
  )
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    sameIgnoringIds(before[before.length - 1 - tail]!, after[after.length - 1 - tail]!)
  )
    tail++;
  const children: Node[] = [];
  after.forEach((child, index) => {
    const fromEnd = after.length - 1 - index;
    const kept = index < head ? index : fromEnd < tail ? before.length - 1 - fromEnd : null;
    if (kept !== null) children.push(...empties[kept]!);
    const match =
      kept !== null
        ? before[kept]!
        : index < before.length - tail && before[index]!.type === child.type
          ? before[index]!
          : null;
    children.push(match && !child.isText ? adoptIds(match, child) : child);
  });
  if (tail > 0 || head === before.length) children.push(...empties[before.length]!);
  return withId(current, next, Fragment.from(children));
};
const withId = (current: Node, next: Node, content: Fragment) => {
  const id = isBlock(next) ? blockIdOf(current) : null;
  if (!id && content === next.content) return next;
  return next.type.create(id ? { ...next.attrs, [BLOCK_ID]: id } : next.attrs, content, next.marks);
};

/** The planned sections at the top level, in order: what a new outline left to fill. */
export const plannedIds = (doc: Node) => {
  const ids: string[] = [];
  doc.forEach((block) => {
    const id = blockIdOf(block);
    if (block.type.name === "pending" && id) ids.push(id);
  });
  return ids;
};

/** A list item's own paragraph: the model points at the item instead. */
const isItemText = (node: Node, parent: Node | null) =>
  node.type.name === "paragraph" &&
  (parent?.type.name === "listItem" || parent?.type.name === "taskItem");

/**
 * The blocks a selection covers, as the model's view names them; nothing for
 * a bare cursor. Bounded, since a select-all should not send every ID.
 */
export const selectedBlockIds = (doc: Node, from: number, to: number, limit = 50) => {
  if (from === to) return [];
  const ids: string[] = [];
  doc.nodesBetween(from, to, (node, _position, parent) => {
    if (ids.length >= limit) return false;
    const id = isBlock(node) && !isItemText(node, parent) ? blockIdOf(node) : null;
    if (id) ids.push(id);
    return true;
  });
  return ids;
};

/**
 * `content` with an ID on every block that lacks one, set before it goes in,
 * so a write is one step rather than one more per new block. IDs already in
 * `doc` are not reused.
 */
export const withFreshIds = (doc: Node, content: Fragment): Fragment => {
  const taken = new Set<string>();
  doc.descendants((node) => {
    const id = isBlock(node) ? blockIdOf(node) : null;
    if (id) taken.add(id);
    return true;
  });
  const mint = () => {
    let id = newBlockId();
    while (taken.has(id)) id = newBlockId();
    taken.add(id);
    return id;
  };
  const visit = (node: Node): Node => {
    if (node.isText) return node;
    const children: Node[] = [];
    node.forEach((child) => children.push(visit(child)));
    const next =
      isBlock(node) && !blockIdOf(node) ? { ...node.attrs, [BLOCK_ID]: mint() } : node.attrs;
    return node.type.create(next, Fragment.from(children), node.marks);
  };
  const nodes: Node[] = [];
  content.forEach((node) => nodes.push(visit(node)));
  return Fragment.from(nodes);
};
