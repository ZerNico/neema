import type { Editor } from "@tiptap/core";
import { useState, useSyncExternalStore } from "react";
import { toMarkdown } from "../../editor/markdown.ts";

/** The document's Markdown, read again whenever the editor's document changes. */
const useMarkdown = (editor: Editor) => {
  const [store] = useState(() => {
    let markdown = toMarkdown(editor.state.doc);
    return {
      subscribe: (onChange: () => void) => {
        const refresh = () => {
          markdown = toMarkdown(editor.state.doc);
          onChange();
        };
        editor.on("update", refresh);
        return () => {
          editor.off("update", refresh);
        };
      },
      read: () => markdown,
    };
  });
  return useSyncExternalStore(store.subscribe, store.read, store.read);
};

/**
 * The document as it is stored. Read-only: every change goes through the
 * editor, so there is one way text moves.
 */
export function DocumentMarkdownView({ editor }: { editor: Editor }) {
  const markdown = useMarkdown(editor);
  return (
    <div className="h-full overflow-auto px-4 py-4">
      <pre
        aria-label="Document Markdown"
        className="text-foreground font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap"
      >
        {markdown || <span className="text-muted-foreground">Nothing written yet.</span>}
      </pre>
    </div>
  );
}
