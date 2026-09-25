import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { useMemo } from "react";
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";
import TextEditor from "~/modules/skills/ui/text-editor.tsx";
import type { DocumentSync } from "../client/document-sync.ts";
import { DOCUMENT_LIMITS } from "../schema.ts";

// Outranks the binding's base theme: a plain 2px caret in the person's colour
// and their name as a small flag above it on hover, in the app's type. The
// base theme's dot sat off the caret's corner.
const collaboratorCarets = EditorView.theme({
  ".cm-ySelectionCaret": {
    borderLeftWidth: "1px",
    borderRightWidth: "1px",
    borderRadius: "1px",
  },
  // A wider invisible target, so revealing the name needs no pixel hunting.
  ".cm-ySelectionCaret::before": {
    content: '""',
    position: "absolute",
    inset: "0 -4px",
  },
  ".cm-ySelectionCaretDot": { display: "none" },
  ".cm-ySelectionInfo": {
    top: "auto",
    bottom: "100%",
    left: "-1px",
    fontFamily: "var(--font-sans)",
    fontWeight: "500",
    fontSize: "0.6875rem",
    lineHeight: "1.5",
    padding: "0 0.375rem",
    borderRadius: "0.375rem 0.375rem 0.375rem 0",
    transition: "opacity 150ms ease-out",
  },
});

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
      collaboratorCarets,
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
