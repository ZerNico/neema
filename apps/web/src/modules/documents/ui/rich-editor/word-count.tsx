import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { countWords, documentCounts, useWordCountShown } from "./document-stats.ts";

const number = new Intl.NumberFormat();
const plural = (count: number, one: string, many: string) =>
  `${number.format(count)} ${count === 1 ? one : many}`;

/**
 * Under the text, as Google Docs' word count shows: the document's words and
 * characters, or how many of its words are selected.
 */
export function WordCount({ editor }: { editor: Editor }) {
  const shown = useWordCountShown();
  const counts = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { doc, selection } = current.state;
      const total = documentCounts(doc);
      const selected = selection.empty
        ? null
        : countWords(doc.textBetween(selection.from, selection.to, "\n", " "));
      return { ...total, selected };
    },
    equalityFn: (a, b) =>
      a?.words === b?.words && a?.characters === b?.characters && a?.selected === b?.selected,
  });
  if (!shown || !counts) return null;
  return (
    <output
      aria-label="Word count"
      className="text-muted-foreground shrink-0 border-t px-4 py-1 text-xs tabular-nums"
    >
      {counts.selected !== null
        ? `${number.format(counts.selected)} of ${plural(counts.words, "word", "words")}`
        : `${plural(counts.words, "word", "words")} · ${plural(counts.characters, "character", "characters")}`}
    </output>
  );
}
