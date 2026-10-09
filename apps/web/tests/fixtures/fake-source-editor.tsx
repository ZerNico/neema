import type { Editor } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { useEffect, useState } from "react";
import {
  parseMarkdown,
  replaceDifference,
  toMarkdown,
} from "~/modules/documents/editor/markdown.ts";

/**
 * Stands in for the rich editor: a textarea over the connection's document as
 * Markdown, writing each change back as the smallest edit, as typing would.
 */
export function FakeSourceEditor({ sync }: { sync: { editor: Editor } }) {
  const { editor } = sync;
  const [value, setValue] = useState(() => toMarkdown(editor.state.doc));
  useEffect(() => {
    const observe = () => setValue(toMarkdown(editor.state.doc));
    editor.on("update", observe);
    return () => {
      editor.off("update", observe);
    };
  }, [editor]);
  return (
    <textarea
      aria-label="Document source"
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        const next = Node.fromJSON(editor.schema, parseMarkdown(event.target.value).toJSON());
        editor.view.dispatch(replaceDifference(editor.state.tr, next));
      }}
    />
  );
}
