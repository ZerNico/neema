import type {
  DocumentLocation,
  DocumentSource,
  IntegrationSource,
  Source,
  WebSource,
} from "./source-schema.ts";

export const isDocumentSource = (source: Source): source is DocumentSource =>
  source.kind === "document";
export const isWebSource = (source: Source): source is WebSource => source.kind === "web";
export const isIntegrationSource = (source: Source): source is IntegrationSource =>
  source.kind === "integration";

export type SourceReference =
  | { readonly url: string; readonly kind: "web" }
  | { readonly url: string; readonly kind: "integration"; readonly integrationId: string }
  | (DocumentLocation & { readonly kind: "document" });

export function documentSourceTarget(source: DocumentLocation): string {
  return `/api/knowledge/${encodeURIComponent(source.collectionId)}/${encodeURIComponent(source.documentId)}/${encodeURIComponent(source.versionId)}`;
}

/** Application-generated target; document sources never carry a model-supplied URL. */
export function sourceTarget(source: SourceReference): string {
  return source.kind === "document"
    ? `${documentSourceTarget(source)}#range=${source.startOffset}-${source.endOffset}`
    : source.url;
}

export function documentLocationLabel(source: DocumentSource): string {
  return (
    [source.page === null ? "" : `Page ${source.page}`, source.headingPath]
      .filter(Boolean)
      .join(" · ") || "Document excerpt"
  );
}

export function sourceIdentity(source: SourceReference): string {
  if (source.kind === "document")
    return JSON.stringify([
      "document",
      source.collectionId,
      source.documentId,
      source.versionId,
      source.startOffset,
      source.endOffset,
    ]);
  if (source.kind === "integration")
    return JSON.stringify(["integration", source.integrationId, source.url]);
  let normalized = source.url;
  try {
    const url = new URL(source.url);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.hash = "";
      normalized = url.href;
    }
  } catch {
    /* Retain historical non-URL identities. */
  }
  return JSON.stringify(["web", normalized]);
}

const fuller = (a: string, b: string) =>
  a.length === b.length ? (a < b ? a : b) : a.length > b.length ? a : b;

/** Merge observations, not citation identities. Extraction evidence never regresses. */
export function mergeSource(previous: Source | undefined, next: Source): Source {
  if (!previous) return next;
  // A malformed observation must not replace another source behind its handle.
  if (sourceIdentity(previous) !== sourceIdentity(next)) return previous;
  const preferred = previous.read === next.read ? undefined : previous.read ? previous : next;
  return {
    ...previous,
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
