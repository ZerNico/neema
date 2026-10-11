import { Extension, type Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * Find and replace in a document: the query, its options and the current
 * match live in this editor's plugin state, never in the shared tree, so
 * searching is one person's and changes nothing anyone else sees.
 */

export interface FindOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export interface Match {
  readonly from: number;
  readonly to: number;
}

export interface FindState {
  /** Whether the find bar is open, and whether it shows replacing. */
  readonly open: false | "find" | "replace";
  readonly query: string;
  readonly options: FindOptions;
  readonly matches: readonly Match[];
  /** The current match's position among them. */
  readonly index: number;
}

export const findKey = new PluginKey<FindState>("documentFind");

const CLOSED: FindState = {
  open: false,
  query: "",
  options: { caseSensitive: false, wholeWord: false },
  matches: [],
  index: 0,
};

/** Stands for an inline node that is not text (a chip, a formula, a picture), which no query matches. */
const OBJECT = "￼";
const WORD = /[\p{L}\p{N}_]/u;

/**
 * Text folded for a search that ignores case, one character at a time: a
 * character whose lowercase is another length ("İ" is two) stays as written,
 * so every offset still points at the same character of the document.
 */
const fold = (text: string) => {
  let folded = "";
  for (const character of text) {
    const lower = character.toLocaleLowerCase();
    folded += lower.length === character.length ? lower : character;
  }
  return folded;
};

/**
 * Every match of `query` in the document, in order and never overlapping, so
 * replacing them all replaces each once. A match never crosses blocks; within
 * one, inline nodes that are not text break it. Each inline node takes one
 * position per character, so offsets map straight to positions.
 */
export function findMatches(doc: PmNode, query: string, options: FindOptions): Match[] {
  if (!query) return [];
  const needle = options.caseSensitive ? query : fold(query);
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = "";
    node.forEach((child) => {
      text += child.isText ? child.text! : OBJECT.repeat(child.nodeSize);
    });
    const haystack = options.caseSensitive ? text : fold(text);
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      if (options.wholeWord && (WORD.test(text[at - 1] ?? "") || WORD.test(text[end] ?? ""))) {
        at = haystack.indexOf(needle, at + 1);
        continue;
      }
      matches.push({ from: pos + 1 + at, to: pos + 1 + end });
      // On past the match, as a word processor's find does.
      at = haystack.indexOf(needle, end);
    }
    return false;
  });
  return matches;
}

/** What a transaction asks of find: open or close the bar, search, or move to a match. */
type FindMeta =
  | { readonly open: FindState["open"]; readonly query?: string | undefined }
  | { readonly query: string; readonly options: FindOptions }
  | { readonly index: number };

const nearest = (matches: readonly Match[], at: number) => {
  const after = matches.findIndex((match) => match.from >= at);
  return after === -1 ? 0 : after;
};

export const findState = (state: EditorState) => findKey.getState(state) ?? CLOSED;

export const findPlugin = () =>
  new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => CLOSED,
      apply(tr, previous, _old, next) {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        if (meta && "open" in meta && meta.query === undefined)
          return { ...previous, open: meta.open };
        if (meta && "query" in meta && meta.query !== undefined) {
          const options = "options" in meta ? meta.options : previous.options;
          const matches = findMatches(next.doc, meta.query, options);
          // A new query starts at the first match from where the reader is.
          return {
            ...previous,
            ...("open" in meta ? { open: meta.open } : {}),
            query: meta.query,
            options,
            matches,
            index: nearest(matches, next.selection.from),
          };
        }
        if (meta && "index" in meta) return { ...previous, index: meta.index };
        if (!tr.docChanged || !previous.query) return previous;
        // Text changed under an open search, someone else's included: search again.
        const matches = findMatches(next.doc, previous.query, previous.options);
        return {
          ...previous,
          matches,
          index: Math.min(previous.index, Math.max(0, matches.length - 1)),
        };
      },
    },
    props: {
      decorations(state) {
        const find = findState(state);
        if (!find.open || !find.matches.length) return null;
        return DecorationSet.create(
          state.doc,
          find.matches.map((match, index) =>
            Decoration.inline(match.from, match.to, {
              class: index === find.index ? "find-match find-match-current" : "find-match",
            }),
          ),
        );
      },
    },
  });

/**
 * Opens or closes the find bar. Opening it on selected words searches for
 * them, as Google Docs does; a selection across blocks is not a query.
 */
export function setFindOpen(editor: Editor, open: FindState["open"]) {
  const { from, to, empty } = editor.state.selection;
  const selected = open && !empty ? editor.state.doc.textBetween(from, to, "\n") : "";
  const query = selected && !selected.includes("\n") ? selected : undefined;
  editor.view.dispatch(editor.state.tr.setMeta(findKey, { open, query } satisfies FindMeta));
}

/** Searches for `query`, highlighting every match. */
export const search = (editor: Editor, query: string, options: FindOptions) =>
  editor.view.dispatch(editor.state.tr.setMeta(findKey, { query, options } satisfies FindMeta));

/**
 * Moves to a match by its position, wrapping at either end, and selects it
 * so it scrolls into view; focus stays where it is, in the find bar.
 */
export function goToMatch(editor: Editor, index: number) {
  const { matches } = findState(editor.state);
  if (!matches.length) return;
  const wrapped = ((index % matches.length) + matches.length) % matches.length;
  const match = matches[wrapped]!;
  editor.view.dispatch(
    editor.state.tr
      .setMeta(findKey, { index: wrapped } satisfies FindMeta)
      .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .scrollIntoView(),
  );
}

/**
 * Replaces the current match, keeping the formatting it had, and moves to the
 * next one past what it wrote, so a replacement containing the query is not
 * found again.
 */
export function replaceCurrent(editor: Editor, replacement: string) {
  const { matches, index } = findState(editor.state);
  const match = matches[index];
  if (!match) return;
  editor.view.dispatch(editor.state.tr.insertText(replacement, match.from, match.to));
  const after = findState(editor.state).matches.findIndex(
    (each) => each.from >= match.from + replacement.length,
  );
  goToMatch(editor, Math.max(0, after));
}

/** Replaces every match in one step, last first so earlier positions hold; one undo takes it back. */
export function replaceAll(editor: Editor, replacement: string) {
  const { matches } = findState(editor.state);
  if (!matches.length) return 0;
  const tr = editor.state.tr;
  for (const match of matches.toReversed()) tr.insertText(replacement, match.from, match.to);
  editor.view.dispatch(tr);
  return matches.length;
}

/** Find's keys: Cmd+F finds, Cmd+Shift+H finds and replaces, as in Google Docs. */
export const DocumentFind = Extension.create({
  name: "documentFind",
  addProseMirrorPlugins: () => [findPlugin()],
  addKeyboardShortcuts() {
    return {
      "Mod-f": () => {
        setFindOpen(this.editor, "find");
        return true;
      },
      "Mod-Shift-h": () => {
        setFindOpen(this.editor, this.editor.isEditable ? "replace" : "find");
        return true;
      },
    };
  },
});
