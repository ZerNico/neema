import type { Editor, JSONContent } from "@tiptap/core";
import { replaceDifference } from "../../editor/markdown.ts";

/**
 * Makes the document read as `json` by one ordinary edit: the smallest change
 * from what it is now, so it syncs like typing, keeps everyone's cursor where
 * the text did not change, and one undo takes it back.
 */
export function restoreVersion(editor: Editor, json: JSONContent) {
  const version = editor.schema.nodeFromJSON(json);
  editor.view.dispatch(replaceDifference(editor.state.tr, version));
}
