import {
  Alert02Icon,
  ArrowDown01Icon,
  GlobalSearchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { ToolActivity, ToolPageStatus } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
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
        title={page.url}
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
          <HugeiconsIcon icon={Alert02Icon} className="text-destructive size-3.5" />
        ) : active ? (
          <span className="text-muted-foreground text-xs">
            {page.status === "reading" ? "reading…" : "queued"}
          </span>
        ) : null}
      </span>
    </li>
  );
}

/** For read_url the query field carries the URL; the hostname reads better. */
const displayTarget = (activity: ToolActivity): string => {
  if (activity.name !== "read_url") return activity.query;
  try {
    return new URL(activity.query).hostname;
  } catch {
    return activity.query;
  }
};

function ActivityEntry({ activity, autoOpen }: { activity: ToolActivity; autoOpen: boolean }) {
  const running = activity.status === "running";
  const reader = activity.name === "read_url";
  const pages = activity.pages ?? [];
  const phase =
    running && activity.resultCount === undefined
      ? "searching"
      : running && pages.some((p) => p.status === "reading" || p.status === "pending")
        ? "reading"
        : running
          ? "searching"
          : activity.status;
  const target = displayTarget(activity);

  const headline = running ? (
    <span className="animate-pulse">
      {reader ? "Reading" : phase === "reading" ? "Reading sources" : "Searching"}
      {target ? <span className="text-foreground/70"> “{target}”</span> : "…"}
    </span>
  ) : activity.status === "error" ? (
    <span>
      {reader ? "Couldn't read" : "Search failed"}
      {target ? <> — “{target}”</> : null}
      {activity.error ? <span className="opacity-70"> ({activity.error})</span> : null}
    </span>
  ) : reader ? (
    <span>
      Read <span className="text-foreground/70">“{target}”</span>
    </span>
  ) : (
    <span>
      Searched <span className="text-foreground/70">“{target}”</span>
      {activity.resultCount !== undefined ? <> — {activity.resultCount} results</> : null}
    </span>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">{headline}</div>
      {pages.length > 0 && autoOpen ? (
        <ul className="flex flex-col gap-1 pl-0.5">
          {pages.map((p) => (
            <PageRow key={p.url} page={p} active={running} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ChatGPT-style tool activity above an assistant answer: while running, a
// live pane with per-source favicon rows streaming their fetch status;
// afterwards a collapsed summary that expands to the source list.
export function ToolActivityBlock({ activities }: { activities: ToolActivity[] }) {
  const anyRunning = activities.some((a) => a.status === "running");
  const [expanded, setExpanded] = useState(anyRunning);
  // Auto-expand while a call runs, auto-collapse when the last one finishes
  // (derived during render — no effect needed).
  const [wasRunning, setWasRunning] = useState(anyRunning);
  if (wasRunning !== anyRunning) {
    setWasRunning(anyRunning);
    setExpanded(anyRunning);
  }

  if (activities.length === 0) return null;

  const totalSources = activities.reduce((n, a) => n + (a.pages?.length ?? 0), 0);
  const suffix = totalSources > 0 ? ` · ${totalSources} sources` : "";
  const searches = activities.filter((a) => a.name !== "read_url").length;
  const reads = activities.length - searches;
  const headerLabel = anyRunning
    ? activities.some((a) => (a.pages ?? []).some((p) => p.status === "reading"))
      ? searches === 0
        ? "Reading page…"
        : "Reading sources…"
      : searches === 0
        ? "Reading page…"
        : "Searching the web…"
    : reads === 0
      ? searches === 1
        ? `Searched the web${suffix}`
        : `Searched the web ${searches} times${suffix}`
      : searches === 0
        ? reads === 1
          ? `Read a page${suffix}`
          : `Read ${reads} pages${suffix}`
        : `Searched and read${suffix}`;

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
      >
        <HugeiconsIcon
          icon={GlobalSearchIcon}
          className={cn("size-4", anyRunning && "animate-pulse")}
        />
        <span className={cn(anyRunning && "animate-pulse")}>{headerLabel}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div className="border-border text-muted-foreground mt-2 flex flex-col gap-3 border-l-2 pl-3 text-sm">
          {activities.map((a) => (
            <ActivityEntry key={a.callId} activity={a} autoOpen />
          ))}
        </div>
      ) : null}
    </div>
  );
}
