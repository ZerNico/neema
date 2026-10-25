import { m } from "~/paraglide/messages.js";
import type { Locale } from "~/paraglide/runtime.js";

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

// The same roles in the reader's language, for the page. The English phrase
// stays for transcript summaries, which the model reads too.
const ROLE_LABELS: Readonly<Record<string, () => string>> = {
  textbox: m.browser_role_field,
  searchbox: m.browser_role_search_field,
  combobox: m.browser_role_field,
  listbox: m.browser_role_list,
  menuitem: m.browser_role_menu_item,
  menuitemcheckbox: m.browser_role_menu_item,
  menuitemradio: m.browser_role_menu_item,
  radio: m.browser_role_option,
  spinbutton: m.browser_role_number_field,
  treeitem: m.browser_role_item,
  heading: m.browser_role_heading,
  link: m.browser_role_link,
  button: m.browser_role_button,
  image: m.browser_role_image,
  img: m.browser_role_image,
  checkbox: m.browser_role_checkbox,
  tab: m.browser_role_tab,
  switch: m.browser_role_switch,
};

// `link "Learn more"`, `heading 2 "Pricing": value (focused)`, as the outline writes them.
const OUTLINE_LABEL = /^([A-Za-z]+)(?: \d+)?(?: "((?:[^"\\]|\\.)*)")?/;

const shortName = (name: string) => (name.length > 60 ? `${name.slice(0, 60)}…` : name);

/**
 * An element as the outline described it, for an English sentence: `the
 * “Learn more” link`, or `a button` without a name. Null when there is
 * nothing to go on.
 */
export function elementPhrase(label: string | null | undefined): string | null {
  const match = label ? OUTLINE_LABEL.exec(label) : null;
  if (!match?.[1]) return null;
  const role = ROLE_WORDS[match[1]] ?? match[1];
  const name = match[2]?.trim();
  if (name) return `the “${shortName(name)}” ${role}`;
  return `${/^[aeiou]/.test(role) ? "an" : "a"} ${role}`;
}

/** The same element in the reader's language, for the page. */
export function elementLabel(label: string | null | undefined): string | null {
  const match = label ? OUTLINE_LABEL.exec(label) : null;
  if (!match?.[1]) return null;
  const role = ROLE_LABELS[match[1]]?.() ?? match[1];
  const name = match[2]?.trim();
  if (name) return m.browser_element_named({ name: shortName(name), role });
  return m.browser_element_unnamed({ role, vowel: /^[aeiou]/.test(role) ? "yes" : "no" });
}

type KeyWord = (inputs: Record<string, never>, options: { locale: Locale }) => string;

const KEY_WORDS: Readonly<Record<string, KeyWord>> = {
  Meta: () => "Cmd",
  Control: m.browser_key_ctrl,
  ArrowUp: m.browser_key_up,
  ArrowDown: m.browser_key_down,
  ArrowLeft: m.browser_key_left,
  ArrowRight: m.browser_key_right,
  Escape: () => "Esc",
  " ": m.browser_key_space,
};

/** "Control+A" as a person writes it: "Ctrl+A", in German "Strg+A". */
export const keyPhrase = (key: string, locale: Locale) =>
  key
    .split("+")
    .map(
      (part) =>
        KEY_WORDS[part]?.({}, { locale }) ?? (part.length === 1 ? part.toUpperCase() : part),
    )
    .join("+");

/**
 * Which way a scroll went, and whether it reached an end: `position` is the
 * page's "top of max" in pixels, as the shell reports it. English, for the
 * transcript summary the model reads.
 */
export function scrollPhrase(deltaX: number, deltaY: number, position?: string): string {
  const [top, max] = (position ?? "").split(" of ").map(Number);
  if (deltaY > 0 && top !== undefined && max !== undefined && max > 0 && top >= max)
    return "to the bottom";
  if (deltaY < 0 && top === 0) return "to the top";
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? "up" : "down";
  return deltaX < 0 ? "left" : "right";
}
