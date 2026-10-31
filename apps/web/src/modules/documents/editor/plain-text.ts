/** Every ASCII punctuation mark, each of which a backslash makes literal. */
const PUNCTUATION = /[!-/:-@[-`{-~]/g;

/**
 * Plain text as Markdown that reads back as the same text: punctuation
 * escaped so nothing becomes formatting, each line its own, and blank lines
 * between paragraphs.
 */
export const plainTextMarkdown = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) =>
      paragraph
        .split("\n")
        // Leading spaces would read as code, and trailing ones as a break.
        .map((line) => line.trim().replace(PUNCTUATION, "\\$&"))
        .filter(Boolean)
        .join("\\\n"),
    )
    .filter(Boolean)
    .join("\n\n");
