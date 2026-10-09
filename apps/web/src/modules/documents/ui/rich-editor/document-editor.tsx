import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { DocumentMarkdownView } from "./markdown-view.tsx";
import { DocumentBubbleMenu } from "./bubble-menu.tsx";
import { DocumentTableMenu } from "./table-menu.tsx";
import { DocumentToolbar } from "./toolbar.tsx";

export type DocumentEditorMode = "live" | "source";
/** The connection's editor; the connection itself stays with the caller. */
export interface DocumentEditorSync {
  readonly editor: Editor;
}

/**
 * The live document: the connection's rich editor mounted here, or its
 * Markdown, read-only. Loaded with the first open document, not the chat.
 */
export default function DocumentEditor({
  sync,
  mode,
  readOnly,
  toolbarSlot,
}: {
  sync: DocumentEditorSync;
  mode: DocumentEditorMode;
  readOnly: boolean;
  /** The panel's actions row, where the formatting controls sit. */
  toolbarSlot: HTMLElement | null;
}) {
  return mode === "live" ? (
    <RichEditor editor={sync.editor} readOnly={readOnly} toolbarSlot={toolbarSlot} />
  ) : (
    <DocumentMarkdownView editor={sync.editor} />
  );
}

function RichEditor({
  editor,
  readOnly,
  toolbarSlot,
}: {
  editor: Editor;
  readOnly: boolean;
  toolbarSlot: HTMLElement | null;
}) {
  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarSlot && !readOnly
        ? createPortal(<DocumentToolbar editor={editor} />, toolbarSlot)
        : null}
      {/* Room above the first line for another person's cursor label. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-7 pb-4">
        <EditorContent editor={editor} className="h-full" />
      </div>
      {readOnly ? null : (
        <>
          <DocumentBubbleMenu editor={editor} />
          <DocumentTableMenu editor={editor} />
        </>
      )}
    </div>
  );
}
