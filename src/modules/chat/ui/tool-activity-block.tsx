import {
  Alert02Icon,
  ArrowDown01Icon,
  GlobalSearchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { ToolActivity, ToolPageStatus, ToolSource } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/primitives/collapsible";
import { cn } from "~/ui/utils";

function PageRow({ page, active }: { page: ToolPageStatus; active: boolean }) {
  const reading = page.status === "reading" || page.status === "pending";
  const label = page.title?.trim() || hostOf(page.url);
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Favicon url={page.url} />
      <a
        href={page.url}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          "hover:text-foreground min-w-0 truncate transition-colors",
          active && reading && "animate-pulse",
        )}
        title={page.error ?? page.url}
      >
        {label}
      </a>
      <span className="text-muted-foreground/70 hidden shrink-0 text-xs sm:inline">
        {hostOf(page.url)}
      </span>
      <span className="ml-auto shrink-0">
        {page.status === "done" ? (
          <HugeiconsIcon icon={Tick02Icon} className="size-3.5 text-emerald-500" />
        ) : page.status === "error" ? (
          <HugeiconsIcon
            icon={Alert02Icon}
            className="text-destructive size-3.5"
            aria-label={page.error ?? "Page failed"}
          />
        ) : active ? (
          <span className="text-muted-foreground text-xs">
            {page.status === "reading" ? "reading…" : "queued"}
          </span>
        ) : null}
      </span>
    </li>
  );
}

function SourceRow({ source }: { source: ToolSource }) {
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Favicon url={source.url} />
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground min-w-0 truncate transition-colors"
        title={source.url}
      >
        {source.title.trim() || hostOf(source.url)}
      </a>
      <span className="text-muted-foreground/70 hidden shrink-0 text-xs sm:inline">
        {hostOf(source.url)}
      </span>
    </li>
  );
}

const quotedTargets = (targets: ReadonlyArray<string>): string => {
  const visible = targets.slice(0, 2).map((target) => `“${target}”`);
  const joined = visible.join(targets.length === 2 ? " and " : ", ");
  return targets.length > 2 ? `${joined}, +${targets.length - 2} more` : joined;
};

function ActivityEntry({
  activity,
  showDetails,
}: {
  activity: ToolActivity;
  showDetails: boolean;
}) {
  const running = activity.status === "running";
  const reader = activity.name === "read_url";
  const pages = activity.pages ?? [];
  const sources = activity.sources ?? [];
  const targetCount = activity.targets.length;
  const searchTargets = quotedTargets(activity.targets);
  const readCount = pages.length || targetCount;

  const headline = running ? (
    <span className="animate-pulse">
      {reader ? `Reading ${readCount || ""} ${readCount === 1 ? "page" : "pages"}` : "Searching"}
      {!reader && searchTargets ? (
        <span className="text-foreground/70"> {searchTargets}</span>
      ) : null}
      {!reader && !searchTargets ? "…" : null}
    </span>
  ) : activity.status === "error" ? (
    <span>
      {reader
        ? `Couldn't read ${readCount === 1 ? "the page" : `${readCount} pages`}`
        : "Search failed"}
      {activity.error ? <span className="opacity-70"> ({activity.error})</span> : null}
    </span>
  ) : reader ? (
    <span>Read {readCount === 1 ? "a page" : `${activity.pagesFetched ?? readCount} pages`}</span>
  ) : (
    <span>
      Searched <span className="text-foreground/70">{searchTargets}</span>
      {activity.resultCount !== undefined ? <> — {activity.resultCount} results</> : null}
    </span>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">{headline}</div>
      {showDetails && (pages.length > 0 || sources.length > 0) ? (
        <ul className="flex flex-col gap-1 pl-0.5">
          {reader
            ? pages.map((page) => <PageRow key={page.url} page={page} active={running} />)
            : sources.map((source) => <SourceRow key={source.index} source={source} />)}
        </ul>
      ) : null}
    </div>
  );
}

// ChatGPT-style tool activity above an assistant answer: while running, a
// live pane with per-source favicon rows streaming their fetch status;
// afterwards a collapsed summary that expands to the source list.
export function ToolActivityBlock({ activities }: { activities: ToolActivity[] }) {
  const anyRunning = activities.some((activity) => activity.status === "running");
  // Open automatically while this turn runs and close when it finishes. A
  // manual choice applies only to the phase in which it was made, matching the
  // reasoning disclosure without render-time state updates.
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const expanded =
    override !== null && override.during === anyRunning ? override.value : anyRunning;

  if (activities.length === 0) return null;

  const totalSources = activities.reduce(
    (total, activity) =>
      total +
      (activity.name === "read_url"
        ? (activity.pages?.length ?? 0)
        : (activity.sources?.length ?? 0)),
    0,
  );
  const suffix = totalSources > 0 ? ` · ${totalSources} sources` : "";
  const searches = activities.filter((activity) => activity.name !== "read_url").length;
  const reads = activities.length - searches;
  const reading = activities.some((activity) =>
    (activity.pages ?? []).some((page) => page.status === "reading"),
  );
  const headerLabel = anyRunning
    ? reading
      ? searches === 0
        ? "Reading pages…"
        : "Reading sources…"
      : searches === 0
        ? "Reading pages…"
        : "Searching the web…"
    : reads === 0
      ? searches === 1
        ? `Searched the web${suffix}`
        : `Searched the web ${searches} times${suffix}`
      : searches === 0
        ? reads === 1
          ? `Read pages${suffix}`
          : `Read pages ${reads} times${suffix}`
        : `Searched and read${suffix}`;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={(next) => setOverride({ during: anyRunning, value: next })}
      className="mb-2"
    >
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors">
        <HugeiconsIcon
          icon={GlobalSearchIcon}
          className={cn("size-4", anyRunning && "animate-pulse")}
        />
        <span className={cn(anyRunning && "animate-pulse")}>{headerLabel}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <div className="border-border text-muted-foreground mt-2 flex flex-col gap-3 border-l-2 pl-3 text-sm">
          {activities.map((activity) => (
            <ActivityEntry
              key={activity.callId}
              activity={activity}
              showDetails={!anyRunning || activity.status === "running"}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
