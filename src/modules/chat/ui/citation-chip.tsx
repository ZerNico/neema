import type { ToolSource } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";

// An inline citation marker rendered in place of a GFM footnote reference.
// Clicking opens the sources panel focused on this source; hovering (pointer
// devices only — Tooltip handles that) previews the title, host and snippet.
export function CitationChip({ source, onOpen }: { source: ToolSource; onOpen: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Source ${source.index}: ${source.title}`}
            className="bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground mx-0.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full py-0.5 pr-1.5 pl-1 align-middle text-[0.7rem] leading-none font-medium transition-colors"
          >
            <Favicon url={source.url} className="size-3" />
            {source.index}
          </button>
        }
      />
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{source.title}</p>
        <p className="text-muted-foreground text-xs">{hostOf(source.url)}</p>
        {source.snippet ? <p className="mt-1 line-clamp-3 text-xs">{source.snippet}</p> : null}
      </TooltipContent>
    </Tooltip>
  );
}
