/**
 * How browser activity reads to a person: what an element is, a key, a
 * scroll. The model's handles (`t1`, `e12`) never appear here; results keep
 * them in their detail, where the model reads them.
 */

// Outline roles in the words a person uses; anything else keeps its name.
const ROLE_WORDS: Readonly<Record<string, string>> = {
  textbox: "field",
  searchbox: "search field",
  combobox: "field",
  listbox: "list",
  menuitem: "menu item",
  menuitemcheckbox: "menu item",
  menuitemradio: "menu item",
  radio: "option",
  spinbutton: "number field",
  treeitem: "item",
  heading: "heading",
};

// `link "Learn more"`, `heading 2 "Pricing": value (focused)`, as the outline writes them.
const OUTLINE_LABEL = /^([A-Za-z]+)(?: \d+)?(?: "((?:[^"\\]|\\.)*)")?/;

/**
 * An element as the outline described it, for a sentence: `the “Learn more”
 * link`, or `a button` without a name. Null when there is nothing to go on.
 */
export function elementPhrase(label: string | null | undefined): string | null {
  const match = label ? OUTLINE_LABEL.exec(label) : null;
  if (!match?.[1]) return null;
  const role = ROLE_WORDS[match[1]] ?? match[1];
  const name = match[2]?.trim();
  if (name) return `the “${name.length > 60 ? `${name.slice(0, 60)}…` : name}” ${role}`;
  return `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;
}

const KEY_WORDS: Readonly<Record<string, string>> = {
  Meta: "Cmd",
  Control: "Ctrl",
  ArrowUp: "Up arrow",
  ArrowDown: "Down arrow",
  ArrowLeft: "Left arrow",
  ArrowRight: "Right arrow",
  Escape: "Esc",
  " ": "Space",
};

/** "Control+A" as a person writes it: "Ctrl+A". */
export const keyPhrase = (key: string) =>
  key
    .split("+")
    .map((part) => KEY_WORDS[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join("+");

/**
 * Which way a scroll went, and whether it reached an end: `position` is the
 * page's "top of max" in pixels, as the shell reports it.
 */
export function scrollPhrase(deltaX: number, deltaY: number, position?: string): string {
  const [top, max] = (position ?? "").split(" of ").map(Number);
  if (deltaY > 0 && top !== undefined && max !== undefined && max > 0 && top >= max)
    return "to the bottom";
  if (deltaY < 0 && top === 0) return "to the top";
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? "up" : "down";
  return deltaX < 0 ? "left" : "right";
}
