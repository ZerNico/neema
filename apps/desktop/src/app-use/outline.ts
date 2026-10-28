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
  /** `e12` to the driver's node id in this look; see `RefBook` for how long `e12` lasts. */
  readonly refs: ReadonlyMap<string, string>;
  readonly truncated: boolean;
}

/**
 * Shown children of one role per element. A long list (neema's own chat history, a mailbox)
 * otherwise took the whole budget in document order. Counted per role, not in all: Chromium
 * lays a page out as one flat run of siblings, and a plain cut hid what ends it, the composer.
 */
const MAX_OF_A_ROLE = 25;

/**
 * The references one chat's looks at one app hand out. An element keeps its reference from look
 * to look, known by app, role, name and place: the model may send several actions on one look in a
 * round, and each action looks again. Numbered per look, a pressed AC that became C shifted
 * every later number, and the round's last click hit the sidebar button (measured). An element
 * that changed gets a new reference, so an old one is refused instead of meaning another.
 */
export class RefBook {
  /** Per identity, the references the last look gave, in the order it met them. */
  private last = new Map<string, ReadonlyArray<string>>();
  private next = 1;

  /**
   * Numbers one look of an app. Elements alike take the last look's references for them in the same
   * order, so the second of two equal rows keeps the second one's reference. What the look
   * did not show is forgotten, so an old reference is never handed to something new.
   */
  start(app: string) {
    const given = new Map<string, string[]>();
    return {
      ref: (node: UiNode) => {
        const frame = node.frame
          ? [node.frame.x, node.frame.y, node.frame.width, node.frame.height]
              .map(Math.round)
              .join(",")
          : `depth ${node.depth}`;
        const identity = `${app}|${node.role}|${node.name ?? ""}|${frame}`;
        const refs = given.get(identity) ?? [];
        const ref = this.last.get(identity)?.[refs.length] ?? `e${this.next++}`;
        refs.push(ref);
        given.set(identity, refs);
        return ref;
      },
      finish: () => {
        this.last = given;
      },
    };
  }
}

/** A shown element whose subtree is still being read. */
interface Open {
  readonly depth: number;
  readonly indent: number;
  /** Its name and value as shown, which a child's text would only repeat. */
  readonly labels: ReadonlyArray<string>;
  readonly children: Map<Role, number>;
  readonly hidden: Map<Role, number>;
}

const opened = (depth: number, indent: number, labels: ReadonlyArray<string>): Open => ({
  depth,
  indent,
  labels,
  children: new Map(),
  hidden: new Map(),
});

/**
 * The numbered outline the model reads beside a look's picture. Written once for every
 * platform: drivers send the raw tree, this decides what is worth the tokens. Positions are
 * in picture pixels, the same space a coordinate action uses.
 */
export const buildOutline = (look: Look, book: RefBook = new RefBook()): Outline => {
  const scale = look.image.width / look.window.width;
  const refs = new Map<string, string>();
  const lines: string[] = [];
  let length = 0;
  let truncated = look.truncated;
  const numbering = book.start(look.app);
  const root = opened(-1, -1, []);
  const open: Open[] = [];
  let skipBelow: number | null = null;

  /** Adds a line within the budget; false once it is spent. */
  const add = (line: string) => {
    if (length + line.length + 1 > OUTLINE_BUDGET) {
      truncated = true;
      return false;
    }
    lines.push(line);
    length += line.length + 1;
    return true;
  };
  /** Leaves an element, saying how many of its children were left out, by role. */
  const close = (done: Open) => {
    for (const [role, count] of done.hidden)
      if (
        !add(`${"  ".repeat(done.indent + 1)}… ${count} more ${role} (scroll or zoom to see them)`)
      )
        return false;
    return true;
  };

  walk: for (const node of look.nodes) {
    if (skipBelow !== null) {
      if (node.depth > skipBelow) continue;
      skipBelow = null;
    }
    while (open.length > 0 && open[open.length - 1]!.depth >= node.depth)
      if (!close(open.pop()!)) break walk;
    if (node.frame && outsideWindow(node.frame, look.window)) {
      // Scrolled out of view, with everything inside it.
      skipBelow = node.depth;
      continue;
    }
    const parent = open[open.length - 1] ?? root;
    if (!shown(node, parent.labels)) continue;
    const ofRole = parent.children.get(node.role) ?? 0;
    if (ofRole >= MAX_OF_A_ROLE) {
      parent.hidden.set(node.role, (parent.hidden.get(node.role) ?? 0) + 1);
      skipBelow = node.depth;
      continue;
    }
    parent.children.set(node.role, ofRole + 1);
    const ref = numbering.ref(node);
    if (!add("  ".repeat(open.length) + describe(ref, node, scale))) break;
    refs.set(ref, node.id);
    open.push(
      opened(
        node.depth,
        open.length,
        [node.name, node.value].flatMap((text) => (text ? [clean(text)] : [])),
      ),
    );
  }
  if (!truncated) while (open.length > 0) if (!close(open.pop()!)) break;
  if (!truncated) close(root);
  numbering.finish();
  return { text: lines.join("\n"), refs, truncated };
};

/**
 * Worth a line: it can be acted on, says something, or gives the outline its shape. Not a
 * nameless group, which web pages wrap around everything (its children still show), nor text
 * that only repeats its parent's name, as a link's label does.
 */
const shown = (node: UiNode, parentLabels: ReadonlyArray<string>) => {
  const label = clean(node.value ?? node.name ?? "");
  if ((node.role === "text" || node.role === "image") && parentLabels.includes(label)) return false;
  if ((node.role === "group" || node.role === "other") && !node.name && !node.value) return false;
  return (
    node.actions.length > 0 ||
    node.name !== undefined ||
    node.value !== undefined ||
    structural.has(node.role)
  );
};

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
