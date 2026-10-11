import type { Node as PmNode } from "@tiptap/pm/model";
import { useSyncExternalStore } from "react";

/**
 * What the outline and the word count read from a document. Both are worked
 * out once per version of the tree (the tree is immutable, so it keys a
 * cache), not on every caret move.
 */

export interface Heading {
  readonly level: number;
  readonly text: string;
  /** Where the heading's text starts. */
  readonly pos: number;
}

const words = new Intl.Segmenter(undefined, { granularity: "word" });

/** Words as a word processor counts them: by the language's word boundaries, punctuation aside. */
export function countWords(text: string) {
  let count = 0;
  for (const segment of words.segment(text)) if (segment.isWordLike) count++;
  return count;
}

const counted = new WeakMap<PmNode, { words: number; characters: number }>();

/** The document's words and characters, block breaks not counted as characters. */
export function documentCounts(doc: PmNode) {
  let known = counted.get(doc);
  if (!known) {
    const text = doc.textBetween(0, doc.content.size, "\n", " ");
    known = { words: countWords(text), characters: text.replaceAll("\n", "").length };
    counted.set(doc, known);
  }
  return known;
}

const outlined = new WeakMap<PmNode, readonly Heading[]>();

/** Every heading in the document, in order, at any depth (a heading in a quote included). */
export function documentHeadings(doc: PmNode): readonly Heading[] {
  let known = outlined.get(doc);
  if (!known) {
    const found: Heading[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name !== "heading") return true;
      found.push({ level: node.attrs.level as number, text: node.textContent, pos: pos + 1 });
      return false;
    });
    known = found;
    outlined.set(doc, known);
  }
  return known;
}

const STORAGE_KEY = "chat.document-word-count";
const listeners = new Set<() => void>();
// Set for this page when the browser refuses storage, so the switch still works until a reload.
let override: boolean | null = null;

const readShown = () => {
  if (override !== null) return override;
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Whether the word count shows under documents, a preference kept on this device. */
export const useWordCountShown = () => useSyncExternalStore(subscribe, readShown, () => true);

export function setWordCountShown(shown: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, shown ? "on" : "off");
    override = null;
  } catch {
    override = shown;
  }
  for (const listener of listeners) listener();
}
