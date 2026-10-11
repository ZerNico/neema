import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { commentsKey } from "../../client/comments-plugin.ts";

/** Starts a comment on the selection: the card holds the range, and the selection collapses. */
export const startComment = (editor: Editor) => {
  const { from, to } = editor.state.selection;
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, to))
      .setMeta(commentsKey, { compose: { from, to } }),
  );
};
