import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { Placeholder } from "@tiptap/extensions";
import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import { DocumentMarkdownView } from "./markdown-view.tsx";
import { documentExtensions } from "../../editor/extensions.ts";
import { DOCUMENT_FIELD } from "../../text.ts";
import { DocumentBubbleMenu } from "./bubble-menu.tsx";
import { SizeCap } from "./size-cap.ts";
import { SlashCommand } from "./slash-command.tsx";
import { DocumentTaskItem } from "./task-item.tsx";
import { DocumentToolbar } from "./toolbar.tsx";
import { openLink } from "./links.ts";

export type DocumentEditorMode = "live" | "source";
/** Only the shared document and presence: the connection itself stays with the caller. */
export interface DocumentEditorSync {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
}

/**
 * The live document: a rich editor bound to the shared tree, or its Markdown
 * as stored, read-only. Loaded with the first open document, not the chat.
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
    <RichEditor sync={sync} readOnly={readOnly} toolbarSlot={toolbarSlot} />
  ) : (
    <DocumentMarkdownView doc={sync.doc} />
  );
}

// The browser draws tasks with the app's checkbox; the schema is unchanged.
const editorExtensions = documentExtensions.map((extension) =>
  extension.name === "taskItem" ? DocumentTaskItem : extension,
);

function RichEditor({
  sync,
  readOnly,
  toolbarSlot,
}: {
  sync: DocumentEditorSync;
  readOnly: boolean;
  toolbarSlot: HTMLElement | null;
}) {
  const editor = useEditor(
    {
      extensions: [
        ...editorExtensions,
        Collaboration.configure({ document: sync.doc, field: DOCUMENT_FIELD }),
        CollaborationCaret.configure({
          provider: { awareness: sync.awareness },
          // The connection already publishes who this is; keep it.
          user: (sync.awareness.getLocalState()?.user as Record<string, unknown>) ?? {},
        }),
        Placeholder.configure({ placeholder: "Write, or type / for blocks" }),
        SlashCommand,
        SizeCap,
      ],
      editable: !readOnly,
      shouldRerenderOnTransaction: false,
      editorProps: {
        handleClick: (view, _position, event) => openLink(view.editable, event),
        attributes: {
          class: "rich-editor",
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Document",
          spellcheck: "true",
        },
      },
    },
    [sync],
  );
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);
  if (!editor) return null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarSlot && !readOnly
        ? createPortal(<DocumentToolbar editor={editor} />, toolbarSlot)
        : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <EditorContent editor={editor} className="h-full" />
      </div>
      {readOnly ? null : <DocumentBubbleMenu editor={editor} />}
    </div>
  );
}
