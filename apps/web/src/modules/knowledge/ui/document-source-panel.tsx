import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { DocumentSource } from "~/modules/tools/source-schema.ts";
import { documentLocationLabel, sourceIdentity } from "~/modules/tools/sources.ts";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { readKnowledgeDocument } from "../server/functions.ts";

/** Each open/range change reauthorizes; extracted bodies are not a client cache. */
export function DocumentSourcePanel({ source }: { source: DocumentSource }) {
  return <DocumentSourceExcerpt key={sourceIdentity(source)} source={source} />;
}

function DocumentSourceExcerpt({ source }: { source: DocumentSource }) {
  const [starts, setStarts] = useState([source.startOffset]);
  const offset = starts.at(-1)!;
  const query = useQuery({
    queryKey: ["knowledge", "source", sourceIdentity(source), offset],
    queryFn: ({ signal }) =>
      readKnowledgeDocument({
        signal,
        data: {
          collectionId: source.collectionId,
          documentId: source.documentId,
          versionId: source.versionId,
          startOffset: offset,
          maxChars: Math.min(16_000, source.endOffset - offset),
        },
      }),
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: "always",
  });
  // Hide prior bodies during access revalidation and after a failed refetch.
  if (query.isFetching || query.isPending) return <Spinner aria-label="Loading source" />;
  if (query.isError || query.data.totalChars < source.endOffset)
    return <p className="text-muted-foreground text-sm">Source unavailable.</p>;
  const data = query.data;
  // The extracted text carries the parser's `[page N]` marker lines. They are
  // real characters of the immutable version (offsets count them), but a
  // reader wants a quiet page divider, not a bracketed token.
  const segments = data.content.split(/^\[page (\d+)\]$/m);
  const partial = data.startOffset > 0 || data.endOffset < data.totalChars;
  // The label above already names the cited page. A divider is only worth
  // drawing where the excerpt actually crosses into a *different* page.
  const labelledPage = source.page;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground text-xs">{documentLocationLabel(source)}</p>
      <div className="text-sm leading-relaxed whitespace-pre-wrap wrap-anywhere">
        {segments.map((segment, index) => {
          // oxlint-disable-next-line react/no-array-index-key -- segments are a fixed split of one text
          if (index % 2 === 0) return <span key={index}>{segment.replace(/^\n/, "")}</span>;
          const page = Number(segment);
          if (page === labelledPage && index === 1 && segments[0]!.trim() === "") return null;
          return (
            <div
              // oxlint-disable-next-line react/no-array-index-key -- segments are a fixed split of one text
              key={index}
              className="text-muted-foreground border-border my-3 border-t pt-2 text-2xs font-medium tracking-wide uppercase"
            >
              Page {page}
            </div>
          );
        })}
      </div>
      {partial ? (
        <p className="text-muted-foreground text-xs">
          This is the part of the document the answer cited, not the whole file.
        </p>
      ) : null}
      <div className="flex gap-2">
        {offset > source.startOffset ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStarts((visited) => visited.slice(0, -1))}
          >
            Previous excerpt
          </Button>
        ) : null}
        {data.endOffset < source.endOffset ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStarts((visited) => [...visited, data.endOffset])}
          >
            Next excerpt
          </Button>
        ) : null}
      </div>
    </div>
  );
}
