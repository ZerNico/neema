import { useState, useSyncExternalStore } from "react";
import type * as Y from "yjs";
import { readMarkdown } from "../../editor/markdown.ts";

/** The document's Markdown, read again whenever the shared tree changes. */
const useMarkdown = (doc: Y.Doc) => {
  const [store] = useState(() => {
    let markdown = readMarkdown(doc);
    return {
      subscribe: (onChange: () => void) => {
        const refresh = () => {
          markdown = readMarkdown(doc);
          onChange();
        };
        doc.on("update", refresh);
        return () => doc.off("update", refresh);
      },
      read: () => markdown,
    };
  });
  return useSyncExternalStore(store.subscribe, store.read, store.read);
};

/**
 * The document as it is stored and as the assistant reads it. Read-only:
 * every change goes through the editor, so there is one way text moves.
 */
export function DocumentMarkdownView({ doc }: { doc: Y.Doc }) {
  const markdown = useMarkdown(doc);
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
