/**
 * Search text handling shared by the server query and the palette. Pure, so a
 * backend other than Postgres could keep the same query rules and hand back
 * the same snippet shape.
 */

/** A matched excerpt as plain text plus the character ranges to emphasise. */
export interface Snippet {
  readonly text: string;
  readonly highlights: ReadonlyArray<readonly [start: number, end: number]>;
}

/** Below this, a prefix matches most of a history and says nothing. */
export const MIN_SEARCH_LENGTH = 2;
export const MAX_SEARCH_LENGTH = 200;
const MAX_SEARCH_TERMS = 8;

/** Letters and digits of any script; everything else only separates terms. */
export const searchTerms = (query: string): string[] =>
  (
    query
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).slice(0, MAX_SEARCH_TERMS);

/**
 * A Postgres `tsquery` matching every term as a word prefix, or null when the
 * query has no terms. Terms hold only letters and digits, so no tsquery
 * operator can reach the parser.
 */
export const prefixTsQuery = (query: string): string | null => {
  const terms = searchTerms(query);
  return terms.length ? terms.map((term) => `${term}:*`).join(" & ") : null;
};

/** Delimiters `ts_headline` wraps matches in; control characters never occur in chat text. */
export const HIGHLIGHT_START = "\u0001";
export const HIGHLIGHT_END = "\u0002";

/** Turns delimited headline output into text plus highlight ranges. */
export const snippetFromHeadline = (headline: string): Snippet => {
  const highlights: Array<readonly [number, number]> = [];
  let text = "";
  let start: number | null = null;
  for (const char of headline) {
    if (char === HIGHLIGHT_START) start = text.length;
    else if (char === HIGHLIGHT_END) {
      if (start !== null && text.length > start) highlights.push([start, text.length]);
      start = null;
    } else text += char;
  }
  return { text, highlights };
};
