import type { DocumentLocation } from "../source-schema.ts";
import { sourceIdentity, type SourceReference } from "../sources.ts";

/** One citation sequence across web URLs and immutable document ranges. */
export interface SourceIndexer {
  indexFor(url: string): number;
  indexForDocument(location: DocumentLocation): number;
}

export const createSourceIndexer = (
  seed: ReadonlyArray<SourceReference & { readonly index: number }>,
): SourceIndexer => {
  let nextIndex = seed.reduce((max, source) => Math.max(max, source.index), 0) + 1;
  const indexes = new Map<string, number>();
  for (const source of seed) {
    const key = sourceIdentity(source);
    if (!indexes.has(key)) indexes.set(key, source.index);
  }
  const allocate = (source: SourceReference) => {
    const key = sourceIdentity(source);
    const existing = indexes.get(key);
    if (existing !== undefined) return existing;
    const assigned = nextIndex++;
    indexes.set(key, assigned);
    return assigned;
  };
  return {
    indexFor: (url) => allocate({ kind: "web", url }),
    indexForDocument: (location) => allocate({ ...location, kind: "document" }),
  };
};
