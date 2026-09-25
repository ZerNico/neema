import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { useMemo } from "react";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import TextEditor from "~/modules/skills/ui/text-editor.tsx";
import type { DocumentSync } from "../client/document-sync.ts";
import { DOCUMENT_LIMITS } from "../schema.ts";

/**
 * The source editor bound to the live document. CodeMirror is uncontrolled
 * here: the binding carries every change both ways, so the panel re-rendering
 * a stale snapshot of this element can never replay old text into it. A new
 * connection is a new editor, keyed by the caller.
 */
export default function DocumentSourceEditor({
  sync,
  readOnly = false,
}: {
  sync: DocumentSync;
  /** A project viewer follows along, cursor and all, but cannot type. */
  readOnly?: boolean;
}) {
  const collaboration = useMemo(() => {
    const undoManager = new Y.UndoManager(sync.text);
    return [
      yCollab(sync.text, sync.awareness, { undoManager }),
      keymap.of(yUndoManagerKeymap),
      // Refused here rather than by the server, which would drop the whole batch.
      EditorState.transactionFilter.of((transaction) =>
        transaction.docChanged &&
        !transaction.annotation(ySyncAnnotation) &&
        transaction.newDoc.length > DOCUMENT_LIMITS.chars
          ? []
          : transaction,
      ),
    ];
  }, [sync]);
  return (
    <TextEditor
      value={sync.text.toString()}
      path="document.md"
      label="Document source"
      readOnly={readOnly}
      collaboration={collaboration}
    />
  );
}
