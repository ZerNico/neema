import type { Look, Role, UiNode } from "./protocol.ts";

/** About 3k tokens. Outlook's full tree is several times that and mostly noise. */
const OUTLINE_BUDGET = 12_000;
const NAME_LIMIT = 120;

/** Roles worth a line with no name or action: they give the outline its shape. */
const structural = new Set<Role>([
  "window",
  "dialog",
  "sheet",
  "toolbar",
  "menuBar",
  "table",
  "outline",
  "list",
  "tabGroup",
  "webArea",
]);

export interface Outline {
  readonly text: string;
  /** `e12` to the driver's node id, for this look only. */
  readonly refs: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}

/**
 * The numbered outline the model reads beside a look's picture. Written once for every
 * platform: drivers send the raw tree, this decides what is worth the tokens. Positions are
 * in picture pixels, the same space a coordinate action uses.
 */
export const buildOutline = (look: Look): Outline => {
  const scale = look.image.width / look.window.width;
  const refs = new Map<string, string>();
  const lines: string[] = [];
  let length = 0;
  let truncated = look.truncated;
  // Indents of the shown ancestors still open, by their tree depth.
  const open: Array<{ depth: number; indent: number }> = [];
  let skipBelow: number | null = null;

  for (const node of look.nodes) {
    if (skipBelow !== null) {
      if (node.depth > skipBelow) continue;
      skipBelow = null;
    }
    while (open.length > 0 && open[open.length - 1]!.depth >= node.depth) open.pop();
    if (node.frame && outsideWindow(node.frame, look.window)) {
      // Scrolled out of view, with everything inside it.
      skipBelow = node.depth;
      continue;
    }
    if (!shown(node)) continue;
    const indent = open.length;
    const ref = `e${refs.size + 1}`;
    const line = "  ".repeat(indent) + describe(ref, node, scale);
    if (length + line.length + 1 > OUTLINE_BUDGET) {
      truncated = true;
      break;
    }
    refs.set(ref, node.id);
    lines.push(line);
    length += line.length + 1;
    open.push({ depth: node.depth, indent });
  }
  return { text: lines.join("\n"), refs, truncated };
};

const shown = (node: UiNode) =>
  node.actions.length > 0 ||
  node.name !== undefined ||
  node.value !== undefined ||
  structural.has(node.role);

const outsideWindow = (frame: NonNullable<UiNode["frame"]>, window: Look["window"]) =>
  frame.x + frame.width <= 0 ||
  frame.y + frame.height <= 0 ||
  frame.x >= window.width ||
  frame.y >= window.height;

const describe = (ref: string, node: UiNode, scale: number) => {
  const name = node.name === undefined ? undefined : clean(node.name);
  const value = node.value === undefined ? undefined : clean(node.value);
  let line = `${ref} ${node.role}`;
  if (name) line += ` ${quote(name)}`;
  if (value && value !== name) line += ` = ${quote(value)}`;
  if (node.frame) {
    const x = Math.round((node.frame.x + node.frame.width / 2) * scale);
    const y = Math.round((node.frame.y + node.frame.height / 2) * scale);
    line += ` @${x},${y}`;
  }
  if (node.disabled) line += " disabled";
  if (node.focused) line += " focused";
  return line;
};

/** Format characters (Calculator wraps every value in a direction mark) are invisible. */
const clean = (text: string) =>
  text
    .replace(/\p{Cf}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const quote = (text: string) => {
  const short = text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT - 1)}…` : text;
  return JSON.stringify(short);
};
