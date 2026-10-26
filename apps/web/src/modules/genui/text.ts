import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";

// Invisible characters in model-written text. A label can look like one
// message and carry another: Unicode tag characters, zero-width marks and
// bidi controls render as nothing yet reach the model. The zero-width joiner
// stays, because emoji sequences are built from it.

const HIDDEN = /(?!‍)\p{Cf}/u;
const HIDDEN_ALL = /(?!‍)\p{Cf}/gu;

/** True when text carries characters a reader cannot see. */
export function hasHiddenText(text: string): boolean {
  return HIDDEN.test(text);
}

/** Text as the reader sees it, without the invisible characters. */
export function stripHiddenText(text: string): string {
  return text.replace(HIDDEN_ALL, "");
}

/** A link or a web address, which a one-click send must not carry. */
export function mentionsUrl(text: string): boolean {
  return /\b(?:https?:\/\/|www\.)\S|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\/\S/i.test(text);
}

const PREVIEW_CHARS = 200;

/**
 * What a block put on the clipboard, as the toast says it. A button's label
 * need not match what it copies, so the text itself is shown, and a long one
 * says how much more follows rather than hiding its end.
 */
export function copiedPreview(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const more = text.length - PREVIEW_CHARS;
  return m.genui_copied_more({
    text: text.slice(0, PREVIEW_CHARS),
    count: more,
    shown: more.toLocaleString(formatLocale()),
  });
}
