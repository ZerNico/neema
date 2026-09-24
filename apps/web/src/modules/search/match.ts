const words = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Every word of the query appears somewhere in the text, in any order. */
export const matchesWords = (haystack: string, query: string) => {
  const lower = haystack.toLowerCase();
  return words(query).every((word) => lower.includes(word));
};
