/**
 * The start of an answer as one line of plain text, for a notification body.
 * Markdown is reduced to its words: citation markers, link targets, emphasis
 * and heading marks go, code keeps its text.
 */
export function answerExcerpt(markdown: string, max = 180): string {
  const text = markdown
    .replace(/\[\^[^\]]*\]/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^```.*$/gm, "")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
