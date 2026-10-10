/**
 * A comment sent to the assistant becomes an ordinary chat message in this
 * form, which the model reads as plain words and the transcript draws as the
 * comment it came from.
 */
const COMMENT = /^Comment on “([^”\n]{1,200})”: ([\s\S]+)$/;

export const commentMessage = (quote: string, body: string) => {
  const line = quote.replace(/\s+/g, " ").trim();
  if (!line) return body;
  const short = line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
  return `Comment on “${short.replaceAll("”", '"')}”: ${body}`;
};

export const readCommentMessage = (text: string) => {
  const match = COMMENT.exec(text);
  return match ? { quote: match[1]!, body: match[2]! } : null;
};
