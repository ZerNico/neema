// Conversation-scoped citation numbering (Onyx-style), shared by every
// source-producing tool in one generation: seeded from earlier messages'
// persisted sources so a URL cited before keeps its number, and new sources —
// whichever tool found them — continue one sequence instead of colliding.

export interface SourceIndexer {
  indexFor(url: string): number;
}

const sourceKey = (raw: string): string => {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return raw;
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
};

export const createSourceIndexer = (
  seed: ReadonlyArray<{ index: number; url: string }>,
): SourceIndexer => {
  let nextIndex = seed.reduce((max, s) => Math.max(max, s.index), 0) + 1;
  const indexByUrl = new Map<string, number>(seed.map((s) => [sourceKey(s.url), s.index]));
  return {
    indexFor(url) {
      const key = sourceKey(url);
      const existing = indexByUrl.get(key);
      if (existing !== undefined) return existing;
      const assigned = nextIndex++;
      indexByUrl.set(key, assigned);
      return assigned;
    },
  };
};
