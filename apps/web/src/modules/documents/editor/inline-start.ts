/**
 * How far ahead an inline extension looks for where it could start. marked
 * asks every extension on every text token, from there to the paragraph's
 * end, so an unbounded search made one long paragraph quadratic: seconds for
 * 100 KB. marked stops plain text at `<` and `[` itself; only a `^[` or `$`
 * more than this far past any of those is read as text.
 */
const LOOKAHEAD = 20_000;

/** Where `pattern` first occurs within the lookahead, or -1. */
export const inlineStart = (src: string, pattern: string | RegExp) => {
  const head = src.length > LOOKAHEAD ? src.slice(0, LOOKAHEAD) : src;
  return typeof pattern === "string" ? head.indexOf(pattern) : head.search(pattern);
};
