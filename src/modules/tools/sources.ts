import type { Source } from "./schema.ts";

const fuller = (a: string, b: string) =>
  a.length === b.length ? (a < b ? a : b) : a.length > b.length ? a : b;

/** Merge observations, not citation identities. Extraction evidence never regresses. */
export function mergeSource(previous: Source | undefined, next: Source): Source {
  if (!previous) return next;
  const preferred = previous.read === next.read ? undefined : previous.read ? previous : next;
  return {
    index: previous.index,
    url: previous.url,
    title: preferred?.title.trim() || fuller(previous.title, next.title),
    snippet: preferred?.snippet.trim() || fuller(previous.snippet, next.snippet),
    read: previous.read || next.read,
  };
}

export function mergeSources(sources: Iterable<Source>): Source[] {
  const byIndex = new Map<number, Source>();
  for (const source of sources)
    byIndex.set(source.index, mergeSource(byIndex.get(source.index), source));
  // oxlint-disable-next-line no-array-sort -- fresh array
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
