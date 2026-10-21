import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { commentAnchors } from "../editor/comments.ts";

export type CommentsMeta =
  | { open: ReadonlyArray<string> }
  | { active: string | null }
  /** A new comment about to be written on this range. */
  | { compose: { from: number; to: number } | null };
interface CommentsState {
  /** Threads that exist and are not resolved; a mark naming any other is not drawn. */
  open: ReadonlySet<string>;
  active: string | null;
  compose: { from: number; to: number } | null;
  decorations: DecorationSet;
}

export const commentsKey = new PluginKey<CommentsState>("documentComments");

const decorate = (
  state: EditorState,
  open: ReadonlySet<string>,
  active: string | null,
  compose: { from: number; to: number } | null,
) => {
  const decorations: Decoration[] = [];
  // The words a new comment is being written on, shown as its text will be.
  if (compose)
    decorations.push(
      Decoration.inline(compose.from, compose.to, { class: "comment-anchor is-active" }),
    );
  // The anchors are a walk over the whole document, redone on every change;
  // a document with no open thread has nothing to draw from it.
  const anchors = open.size ? commentAnchors(state.doc) : [];
  for (const [thread, anchor] of anchors) {
    if (!open.has(thread)) continue;
    // Each text node under the mark, so an anchor across formatting stays one highlight.
    state.doc.nodesBetween(anchor.from, anchor.to, (node, position) => {
      if (!node.isText) return true;
      if (!node.marks.some((mark) => mark.attrs.thread === thread)) return false;
      decorations.push(
        Decoration.inline(position, position + node.nodeSize, {
          class: thread === active ? "comment-anchor is-active" : "comment-anchor",
          "data-thread": thread,
        }),
      );
      return false;
    });
  }
  return DecorationSet.create(state.doc, decorations);
};

/** Which commented text to draw, the thread a click opened, and a comment being written. */
export const commentsPlugin = () =>
  new Plugin<CommentsState>({
    key: commentsKey,
    state: {
      init: (_config, state) => ({
        open: new Set(),
        active: null,
        compose: null,
        decorations: DecorationSet.create(state.doc, []),
      }),
      apply: (tr: Transaction, value, _old, state) => {
        const meta = tr.getMeta(commentsKey) as CommentsMeta | undefined;
        if (!meta && !tr.docChanged) return value;
        const next = { ...value };
        if (meta && "open" in meta) next.open = new Set(meta.open);
        if (meta && "active" in meta) next.active = meta.active;
        if (meta && "compose" in meta) next.compose = meta.compose;
        if (next.compose && tr.docChanged)
          next.compose = {
            from: tr.mapping.map(next.compose.from, 1),
            to: tr.mapping.map(next.compose.to, -1),
          };
        if (next.compose && next.compose.from >= next.compose.to) next.compose = null;
        next.decorations = decorate(state, next.open, next.active, next.compose);
        return next;
      },
    },
    props: {
      decorations: (state) => commentsKey.getState(state)?.decorations ?? null,
      // Clicking commented text opens its thread; anywhere else closes it.
      handleClick: (view, position) => {
        const current = commentsKey.getState(view.state);
        if (!current) return false;
        const marks = view.state.doc.resolve(position).marks();
        const thread =
          marks
            .map((mark) => mark.attrs.thread as unknown)
            .find((each): each is string => typeof each === "string" && current.open.has(each)) ??
          null;
        if (thread !== current.active)
          view.dispatch(view.state.tr.setMeta(commentsKey, { active: thread }));
        return false;
      },
    },
  });
