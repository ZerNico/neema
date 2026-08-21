import { useCallback, useEffect, useRef } from "react";
import type { ToolSource } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import { Badge } from "~/ui/primitives/badge";
import { useDetailPanel, useDetailPanelFocus } from "~/ui/detail-panel";
import { cn } from "~/ui/utils";

function SourceRow({ source, focused }: { source: ToolSource; focused: boolean }) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <li
      ref={ref}
      className={cn(
        "rounded-lg border p-3 transition-colors",
        focused ? "border-primary bg-accent/50" : "border-transparent",
      )}
    >
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className="group flex flex-col gap-1.5"
      >
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground w-4 shrink-0 text-xs tabular-nums">
            {source.index}
          </span>
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
          {source.read ? "read in full" : "snippet only"}
        </Badge>
      </a>
    </li>
  );
}

/**
 * Opens this message's sources in the detail panel, optionally focusing one row.
 *
 * `sources` is snapshotted into the panel body, so only call this for a message
 * whose sources are final (see the body-props contract in detail-panel).
 */
export function useSourcesPanel(messageId: string, sources: ToolSource[]) {
  const panel = useDetailPanel();
  return useCallback(
    (focus?: number) => {
      panel.open({
        id: `sources:${messageId}`,
        title: "Sources",
        subtitle: `${sources.length}`,
        body: <SourcesPanelBody sources={sources} />,
        ...(focus !== undefined ? { focus } : {}),
      });
    },
    [panel, messageId, sources],
  );
}

// The detail-panel body for a message's sources. Takes only the source list —
// which for a completed message is stable — plus the panel's focus hint so a
// citation-chip click scrolls its row into view and highlights it.
export function SourcesPanelBody({ sources }: { sources: ToolSource[] }) {
  const focus = useDetailPanelFocus();
  return (
    <ul className="flex flex-col gap-1">
      {sources.map((source) => (
        <SourceRow key={source.index} source={source} focused={focus === source.index} />
      ))}
    </ul>
  );
}
