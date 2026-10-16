/**
 * A comment sent to the assistant becomes an ordinary chat message in this
 * form, which the model reads as plain words and the transcript draws as the
 * comment it came from. One on a file names it and its reference, which the
 * model's file tools take as they are; the transcript shows only the name.
 */
const COMMENT =
  /^Comment on “([^”\n]{1,200})”(?: in ([^\n]{1,255}?) \((attachment:[0-9a-f-]{36})\))?: ([\s\S]+)$/;

/** The file a comment is about: its name, and the reference the model reads it by. */
export interface CommentFile {
  readonly name: string;
  readonly ref: `attachment:${string}`;
}

export const commentMessage = (quote: string, body: string, file?: CommentFile) => {
  const line = quote.replace(/\s+/g, " ").trim();
  if (!line) return body;
  const short = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  const name = file?.name.replace(/\s+/g, " ").trim().slice(0, 255);
  const where = file && name ? ` in ${name} (${file.ref})` : "";
  return `Comment on “${short.replaceAll("”", '"')}”${where}: ${body}`;
};

export const readCommentMessage = (text: string) => {
  const match = COMMENT.exec(text);
  if (!match) return null;
  const [, quote, file, , body] = match;
  return { quote: quote!, body: body!, ...(file ? { file } : {}) };
};
