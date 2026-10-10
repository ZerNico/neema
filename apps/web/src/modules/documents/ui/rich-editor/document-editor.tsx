import type { Editor } from "@tiptap/core";
import { EditorContent } from "@tiptap/react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AskPopover } from "./ask-popover.tsx";
import { DocumentBubbleMenu } from "./bubble-menu.tsx";
import { EditorContextMenu } from "./context-menu.tsx";
import { setEditorHooks, type EditorHooks } from "./editor-hooks.ts";
import type { DocumentDiscussion } from "../../client/use-document.ts";
import { CommentCard } from "./comment-card.tsx";
import { DocumentToolbar } from "./toolbar.tsx";

/** The connection's editor; the connection itself stays with the caller. */
export interface DocumentEditorSync {
  readonly editor: Editor;
}

/**
 * The live document: the connection's rich editor mounted here. Loaded with
 * the first open document, not the chat.
 */
export default function DocumentEditor({
  sync,
  readOnly,
  toolbarSlot,
  hooks,
  discussion,
}: {
  sync: DocumentEditorSync;
  readOnly: boolean;
  /** The panel's actions row, where the formatting controls sit. */
  toolbarSlot: HTMLElement | null;
  /** Who can be mentioned and how to ask the assistant; none in tests and outside a chat. */
  hooks?: EditorHooks | undefined;
  /** Comments and the assistant's changes; none in tests. */
  discussion?: DocumentDiscussion | undefined;
}) {
  useEffect(() => {
    if (hooks) setEditorHooks(sync.editor, hooks);
  }, [hooks, sync.editor]);
  return (
    <RichEditor
      editor={sync.editor}
      readOnly={readOnly}
      toolbarSlot={toolbarSlot}
      discussion={discussion}
    />
  );
}

function RichEditor({
  editor,
  readOnly,
  toolbarSlot,
  discussion,
}: {
  editor: Editor;
  readOnly: boolean;
  toolbarSlot: HTMLElement | null;
  discussion: DocumentDiscussion | undefined;
}) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbarSlot && !readOnly
        ? createPortal(<DocumentToolbar editor={editor} />, toolbarSlot)
        : null}
      {/* Room above the first line for another person's cursor label. */}
      <div
        ref={setScroller}
        className="relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-7 pb-4"
      >
        <EditorContextMenu editor={editor}>
          {/* A wide panel centres the text at a readable line length. */}
          <EditorContent editor={editor} className="mx-auto flex w-full max-w-3xl grow flex-col" />
        </EditorContextMenu>
        {/* Room past the end, so the last lines can be read and written mid-panel. */}
        <div
          aria-hidden
          className="h-[40vh] shrink-0 cursor-text"
          onMouseDown={(event) => {
            if (readOnly) return;
            event.preventDefault();
            editor.commands.focus("end");
          }}
        />
      </div>
      {readOnly ? null : (
        <>
          <DocumentBubbleMenu editor={editor} scroller={scroller} />
          <AskPopover editor={editor} />
          {discussion ? (
            <CommentCard editor={editor} discussion={discussion} canEdit container={scroller} />
          ) : null}
        </>
      )}
    </div>
  );
}
