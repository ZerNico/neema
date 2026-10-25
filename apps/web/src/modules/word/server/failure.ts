import { type Localized, localized, verbatim } from "~/i18n/localized.ts";
import { m } from "~/paraglide/messages.js";
import { WordError } from "../errors.ts";
import { WORD_LIMITS } from "../limits.ts";

const MIB = WORD_LIMITS.compressedBytes / 1024 / 1024;
const count = (digits: string) => Number(digits.replaceAll(",", ""));
const exact = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "u");

/**
 * The failures a person meets opening a Word file, by the English sentence
 * the worker wrote. A worker reports only a code and that sentence, which the
 * model reads as it is; a person reads it in their own language.
 */
const known: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => Localized]> = [
  [
    exact(`A Word file can have at most ${WORD_LIMITS.parts} parts.`),
    () => localized(m.word_error_too_many_parts, { max: WORD_LIMITS.parts }),
  ],
  [
    exact("This Word file expands past the size the app can open."),
    () => localized(m.word_error_expands_too_far),
  ],
  [
    exact("Macro-enabled documents aren't supported; save it as .docx without macros."),
    () => localized(m.word_error_macros),
  ],
  [
    exact("Documents with embedded objects or controls aren't supported."),
    () => localized(m.word_error_embedded),
  ],
  [exact("This is not a Word file the app can open."), () => localized(m.word_error_not_openable)],
  [
    /^This is not a Word file the app can open: (.*)$/su,
    ([, detail]) => localized(m.word_error_not_openable_detail, { detail: detail! }),
  ],
  [
    exact(`A Word file can be at most ${MIB} MiB.`),
    () => localized(m.word_error_too_large, { max: MIB }),
  ],
  [
    exact(`A Word file can have at most ${WORD_LIMITS.blocks} paragraphs and tables.`),
    () => localized(m.word_error_too_many_blocks, { max: WORD_LIMITS.blocks }),
  ],
  [
    /^This Word file is too long for a document: it has ([\d,]+) paragraphs, list items and tables, and a document holds ([\d,]+)\.$/u,
    ([, has, max]) =>
      localized(m.word_error_import_too_many_blocks, { count: count(has!), max: count(max!) }),
  ],
  [
    /^This Word file is too long for a document: it has ([\d,]+) characters, and a document holds ([\d,]+)\.$/u,
    ([, has, max]) =>
      localized(m.word_error_import_too_many_chars, { count: count(has!), max: count(max!) }),
  ],
  [exact("Word processing has stopped."), () => localized(m.word_error_stopped)],
  [exact("Word processing is busy; retry later."), () => localized(m.word_error_busy)],
  [exact("Word processing was cancelled."), () => localized(m.word_error_cancelled)],
  [exact("Word processing timed out."), () => localized(m.word_error_timeout)],
  [exact("Word processing failed."), () => localized(m.word_error_failed)],
  [
    /^Word processing stopped unexpectedly \((.*)\)\.$/u,
    ([, reason]) => localized(m.word_error_exited, { reason: reason! }),
  ],
];

/**
 * A Word failure as a person reads it. One the list does not know, an
 * operation the model got wrong above all, stays in the worker's words.
 */
export const wordFailure = (error: WordError): Localized => {
  for (const [pattern, words] of known) {
    const match = pattern.exec(error.message);
    if (match) return words(match);
  }
  return verbatim(error.message);
};

/** Any failure reading a Word file, worded for a person: a Word one as above, else that it could not be read. */
export const wordReadFailure = (name: string, error: unknown): Localized =>
  error instanceof WordError ? wordFailure(error) : localized(m.word_error_unreadable, { name });
