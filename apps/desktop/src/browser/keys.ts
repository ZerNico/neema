/** A key press, as the page's own key events take it. */
export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly keyCode: number;
  /** What the key types, absent for keys that type nothing or with a command modifier. */
  readonly text?: string;
  /** Alt 1, Control 2, Meta 4, Shift 8, as the protocol counts them. */
  readonly modifiers: number;
}

const NAMED: Record<string, Omit<KeyPress, "modifiers">> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};
const ALIASES: Record<string, string> = { Esc: "Escape", Return: "Enter", " ": "Space" };
const MODIFIERS: Record<string, number> = {
  Alt: 1,
  Option: 1,
  Control: 2,
  Ctrl: 2,
  Meta: 4,
  Command: 4,
  Cmd: 4,
  Shift: 8,
};

/**
 * Reads "Enter", "a", "Shift+Tab" or "Control+A" into one press, or null for
 * anything it does not know rather than a guess. Command modifiers type nothing.
 */
export function parseKey(input: string): KeyPress | null {
  const parts = input.split("+").map((part) => part.trim());
  const name = parts.pop();
  if (!name) return null;
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part];
    if (bit === undefined) return null;
    modifiers |= bit;
  }
  const typing = (modifiers & (2 | 4)) === 0;
  const named = NAMED[ALIASES[name] ?? name];
  if (named) {
    const { text, ...rest } = named;
    return { ...rest, ...(typing && text ? { text } : {}), modifiers };
  }
  if ([...name].length !== 1) return null;
  const upper = name.toUpperCase();
  const code = /[A-Z]/.test(upper) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
  const shifted = (modifiers & 8) !== 0;
  const key = /[a-z]/i.test(name) ? (shifted ? upper : name.toLowerCase()) : name;
  return {
    key,
    code,
    keyCode: upper.charCodeAt(0),
    ...(typing ? { text: key } : {}),
    modifiers,
  };
}
