import type { ToolSource } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";

// An inline citation rendered in place of a GFM footnote reference: the
// source's favicon and title, linking straight to the page. Citation numbers
// are an internal handle between the model and the source list; a reader
// wants to know what the source is, not which one it was. The full list is
// still a click away in the message menu; hovering previews host and snippet.
export function CitationChip({ source }: { source: ToolSource }) {
  const label = source.title?.trim() || hostOf(source.url);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={0}
        closeDelay={100}
        render={
          <a
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`Source: ${label}`}
            className="bg-muted text-muted-foreground hover:bg-foreground/15 hover:text-foreground hover:ring-foreground/20 focus-visible:ring-ring mx-0.5 inline-flex max-w-[12rem] translate-y-[-1px] items-center gap-1 rounded-full py-0.5 pr-2 pl-1 align-middle text-[0.7rem] leading-none font-medium no-underline ring-1 ring-transparent transition-colors duration-100 outline-none select-none focus-visible:ring-2"
          />
        }
      >
        <Favicon url={source.url} className="size-3" />
        <span className="min-w-0 truncate">{label}</span>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        sideOffset={8}
        showArrow={false}
        className="bg-popover text-popover-foreground block w-80 max-w-[calc(100vw-2rem)] rounded-2xl border p-3.5 shadow-md duration-100 motion-reduce:animate-none"
      >
        <div className="text-muted-foreground mb-2 flex min-w-0 items-center gap-2 text-xs">
          <Favicon url={source.url} />
          <span className="truncate">{hostOf(source.url)}</span>
        </div>
        <p className="text-sm leading-snug font-medium wrap-anywhere">{label}</p>
        {source.snippet?.trim() ? (
          <p className="text-muted-foreground mt-1.5 line-clamp-3 text-xs leading-relaxed wrap-anywhere">
            {source.snippet}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
