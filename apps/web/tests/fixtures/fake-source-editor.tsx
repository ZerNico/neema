import { useEffect, useState } from "react";
import type { DocumentSync } from "~/modules/documents/client/document-sync.ts";
import { readMarkdown, writeMarkdown } from "~/modules/documents/editor/markdown.ts";

/**
 * Stands in for the rich editor: a textarea over the document's Markdown,
 * writing each change back to the tree the way the server applies an edit.
 */
export function FakeSourceEditor({ sync }: { sync: Pick<DocumentSync, "doc"> }) {
  const [value, setValue] = useState(() => readMarkdown(sync.doc));
  useEffect(() => {
    const observe = () => setValue(readMarkdown(sync.doc));
    sync.doc.on("update", observe);
    return () => sync.doc.off("update", observe);
  }, [sync]);
  return (
    <textarea
      aria-label="Document source"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        writeMarkdown(sync.doc, event.target.value);
      }}
    />
  );
}
