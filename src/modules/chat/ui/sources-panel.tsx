import { useCallback } from "react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import { Badge } from "~/ui/primitives/badge";
import { useDetailPanel } from "~/ui/detail-panel";

function SourceRow({ source }: { source: ToolSource }) {
  return (
    <li className="rounded-lg p-3">
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className="group flex flex-col gap-1.5"
      >
        <div className="flex items-center gap-2">
          <Favicon url={source.url} className="size-4" />
          <span className="text-muted-foreground min-w-0 truncate text-xs">
            {hostOf(source.url)}
          </span>
        </div>
        <p className="group-hover:text-primary text-sm leading-snug font-medium transition-colors">
          {source.title || hostOf(source.url)}
        </p>
        {source.snippet ? (
          <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
            {source.snippet}
          </p>
        ) : null}
        <Badge variant="secondary" className="mt-0.5 w-fit text-[0.65rem]">
          {source.read ? "page extracted" : "snippet only"}
        </Badge>
      </a>
    </li>
  );
}

/**
 * Opens this message's sources in the detail panel.
 *
 * `sources` is snapshotted into the panel body on each open; it doesn't
 * subscribe to changes while the panel stays open.
 */
export function useSourcesPanel(messageId: string, sources: ToolSource[]) {
  const panel = useDetailPanel();
  return useCallback(() => {
    panel.open({
      id: `sources:${messageId}`,
      title: "Sources",
      subtitle: `${sources.length}`,
      body: <SourcesPanelBody sources={sources} />,
    });
  }, [panel, messageId, sources]);
}

// The detail-panel body for a message's sources. Takes only the source list,
// which for a completed message is stable. Rows are keyed by the citation
// index but never show it: the number is the model's handle, not the reader's.
export function SourcesPanelBody({ sources }: { sources: ToolSource[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {sources.map((source) => (
        <SourceRow key={source.index} source={source} />
      ))}
    </ul>
  );
}
