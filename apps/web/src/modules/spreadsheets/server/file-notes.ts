import { makeLegacyComment, type LegacyComment, type Worksheet } from "@office-kit/xlsx/worksheet";

/**
 * Cell notes as Excel files keep them, read as comment threads. A note is
 * one author and text; Excel also writes each threaded comment as a note
 * for older readers, its comment and replies laid out in the text.
 */
export interface FileNote {
  readonly ref: string;
  /** The thread's comments in order, each with the name the file gave, empty when none. */
  readonly entries: ReadonlyArray<{ readonly author: string; readonly text: string }>;
}

export const NOTE_LIMITS = { notes: 500, text: 10_000 } as const;

/** Excel's stand-in author for a threaded comment: an ID, not a name. */
const THREAD_ID_AUTHOR = /^tc=\{?[0-9a-f-]+\}?$/i;

/** A note as a thread: one comment, or a threaded comment's comment and replies. */
export function readNote(note: LegacyComment): FileNote | null {
  const author = THREAD_ID_AUTHOR.test(note.author.trim()) ? "" : note.author.trim();
  const text = note.text.replace(/\r\n?/g, "\n");
  if (text.startsWith("[Threaded comment]")) {
    // Its body follows the explanation, each part under "Comment:" or "Reply:", indented.
    const parts = text.split(/^(?:Comment|Reply):[ \t]*$/m).slice(1);
    const entries = parts
      .map((part) => ({
        author: "",
        text: part
          .split("\n")
          .map((line) => line.replace(/^ {4}/, ""))
          .join("\n")
          .trim()
          .slice(0, NOTE_LIMITS.text),
      }))
      .filter((each) => each.text);
    return entries.length ? { ref: note.ref, entries } : null;
  }
  // Excel starts a note's text with its author's name, which the note keeps apart.
  const body = (author && text.startsWith(`${author}:`) ? text.slice(author.length + 1) : text)
    .trim()
    .slice(0, NOTE_LIMITS.text);
  return body ? { ref: note.ref, entries: [{ author, text: body }] } : null;
}

/** Writes each thread as one note: its first author, and the replies after the first comment. */
export function writeNotes(sheet: Worksheet, notes: readonly FileNote[]) {
  for (const note of notes.slice(0, NOTE_LIMITS.notes)) {
    const [first, ...replies] = note.entries;
    if (!first) continue;
    sheet.legacyComments.push(
      makeLegacyComment({
        ref: note.ref,
        author: first.author || "Comment",
        text: [
          first.text,
          ...replies.map((reply) => `${reply.author || "Reply"}: ${reply.text}`),
        ].join("\n\n"),
      }),
    );
  }
}
