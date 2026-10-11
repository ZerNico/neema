import type { KeyboardEvent } from "react";
import { serialOf } from "@chat/sheet/dates";
import type { SheetLocale } from "@chat/sheet/locales";
import type { Axis } from "@chat/sheet/model";
import { formatValue } from "@chat/sheet/number-format";
import type { NumberFormatKind } from "./format-commands.ts";
import type { GridCommand } from "./grid-types.ts";

/** Excel's Ctrl+Shift number formats, by the character each key types. */
const FORMAT_KEYS: Readonly<Record<string, NumberFormatKind>> = {
  "~": "general",
  "!": "number",
  $: "currency",
  "%": "percent",
  "#": "date",
  "@": "time",
  "^": "scientific",
};

/** Cmd or Ctrl with a letter, by the lowercase letter and whether Shift is held. */
const COMMAND_KEYS: Readonly<Record<string, GridCommand>> = {
  "shift l": { kind: "filter" },
  // Cmd+Shift+K and J group and ungroup on a Mac; Cmd+K inserts a link.
  "shift k": { kind: "group" },
  "shift j": { kind: "ungroup" },
  k: { kind: "link" },
  z: { kind: "undo" },
  "shift z": { kind: "redo" },
  y: { kind: "redo" },
  "shift y": { kind: "redo" },
  d: { kind: "fill", direction: "down" },
  "shift d": { kind: "fill", direction: "down" },
  r: { kind: "fill", direction: "right" },
  "shift r": { kind: "fill", direction: "right" },
  b: { kind: "toggle", property: "bold" },
  "shift b": { kind: "toggle", property: "bold" },
  i: { kind: "toggle", property: "italic" },
  "shift i": { kind: "toggle", property: "italic" },
  u: { kind: "toggle", property: "underline" },
  "shift u": { kind: "toggle", property: "underline" },
  // Ctrl+5 strikes through, as in Excel.
  "5": { kind: "toggle", property: "strike" },
  "shift 5": { kind: "toggle", property: "strike" },
};

/** What Cmd or Ctrl with a letter asks of a sheet that writes; null for any other key. */
export function commandShortcut(event: KeyboardEvent): GridCommand | null {
  const lower = event.key.toLowerCase();
  return COMMAND_KEYS[event.shiftKey ? `shift ${lower}` : lower] ?? null;
}

/**
 * Excel's Ctrl and Ctrl+Shift shortcuts for formats, borders, hiding,
 * inserting and deleting; null for any other key. Inserting and deleting
 * need whole rows or columns selected in `box`.
 */
export function ctrlShortcut(
  event: KeyboardEvent,
  box: { top: number; bottom: number; left: number; right: number } | null,
  rowCount: number,
  colCount: number,
): GridCommand | null {
  // Ctrl alone, as Excel for Mac has them too: Cmd with these keys zooms the page
  // (Cmd+0, Cmd+Minus, Cmd+Plus) or takes a screenshot (Cmd+Shift+4).
  if (!event.ctrlKey || event.metaKey) return null;
  const format = event.shiftKey ? FORMAT_KEYS[event.key] : undefined;
  if (format) return { kind: "numberFormat", format };
  if (event.shiftKey && event.key === "&") return { kind: "borders", border: "outer" };
  if (event.shiftKey && event.key === "_") return { kind: "borders", border: "none" };
  // Ctrl+9 hides rows and Ctrl+0 columns; with Shift they show again.
  if (event.code === "Digit9" || event.code === "Digit0")
    return {
      kind: "hide",
      axis: event.code === "Digit9" ? "rows" : "columns",
      hidden: !event.shiftKey,
    };
  if (event.key === "-" || event.key === "+" || (event.shiftKey && event.key === "=")) {
    // Only whole rows or columns: for cells, Excel asks which way to shift them.
    if (!box) return null;
    const axis: Axis | null =
      box.left === 0 && box.right === colCount - 1
        ? "rows"
        : box.top === 0 && box.bottom === rowCount - 1
          ? "columns"
          : null;
    return axis ? { kind: event.key === "-" ? "delete" : "insert", axis } : null;
  }
  return null;
}

/** Ctrl+; asks for today's date and Ctrl+Shift+; (or Cmd+; on a Mac) for the time, as in Excel. */
export const stampOf = (event: KeyboardEvent): "date" | "time" | null => {
  if (event.altKey || (event.key !== ";" && event.key !== ":")) return null;
  if (event.ctrlKey && !event.metaKey) return event.shiftKey ? "time" : "date";
  return event.metaKey && !event.ctrlKey ? "time" : null;
};

/** Today or now as the text a cell reads back as that date or time. */
export function stampText(kind: "date" | "time", locale: SheetLocale) {
  const now = new Date();
  if (kind === "time")
    return formatValue((now.getHours() * 60 + now.getMinutes()) / 1440, "h:mm", locale)?.text ?? "";
  const serial = serialOf(now.getFullYear(), now.getMonth() + 1, now.getDate()) ?? 0;
  return formatValue(serial, locale.shortDate, locale)?.text ?? "";
}
