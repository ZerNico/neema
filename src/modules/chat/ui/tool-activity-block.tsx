import {
  Alert02Icon,
  ArrowDown01Icon,
  GlobalSearchIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import type { ToolPageStatus, WebToolActivity } from "../client/use-message-stream.ts";
import { Favicon, hostOf } from "./favicon.tsx";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";

const QUERY_LIMIT = 2;
const PAGE_LIMIT = 3;
const COLLAPSE_DELAY_MS = 800;

const urlKey = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return raw;
  }
};

const uniqueTargets = (activities: ReadonlyArray<WebToolActivity>): string[] => {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const activity of activities) {
    if (activity.name === "read_url") continue;
    for (const raw of activity.targets) {
      const target = raw.trim();
      if (!target || seen.has(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }
  return targets;
};

const openedPages = (activities: ReadonlyArray<WebToolActivity>): ToolPageStatus[] => {
  const byUrl = new Map<string, ToolPageStatus>();
  for (const activity of activities) {
    if (activity.name !== "read_url") continue;
    for (const target of activity.targets) {
      const key = urlKey(target);
      if (!byUrl.has(key)) byUrl.set(key, { url: target, status: "pending" });
    }
    for (const page of activity.pages ?? []) {
      const key = urlKey(page.url);
      const previous = byUrl.get(key);
      byUrl.set(key, {
        ...previous,
        ...page,
        ...(page.title?.trim()
          ? { title: page.title }
          : previous?.title
            ? { title: previous.title }
            : {}),
      });
    }
  }
  return [...byUrl.values()];
};

const uniqueSourceCount = (
  activities: ReadonlyArray<WebToolActivity>,
  used: ReadonlySet<number> | undefined,
): number => {
  const urls = new Set<string>();
  for (const activity of activities) {
    for (const source of activity.sources ?? []) {
      if (used && !used.has(source.index)) continue;
      if (source.kind !== "document") urls.add(urlKey(source.url));
    }
  }
  return urls.size;
};

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
          active && reading && "text-shimmer",
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
          <HugeiconsIcon icon={Tick02Icon} className="size-3.5 text-success" />
        ) : page.status === "error" ? (
          <HugeiconsIcon
            icon={Alert02Icon}
            className="text-destructive size-3.5"
            aria-label="Page unavailable"
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

const quotedTargets = (targets: ReadonlyArray<string>): string => {
  const visible = targets.slice(0, QUERY_LIMIT).map((target) => `“${target}”`);
  const joined = visible.join(visible.length === 2 ? " and " : "");
  return targets.length > QUERY_LIMIT ? `${joined}, +${targets.length - QUERY_LIMIT} more` : joined;
};

const pagePriority: Record<ToolPageStatus["status"], number> = {
  reading: 0,
  pending: 1,
  error: 2,
  done: 3,
};

export function ToolActivityBlock({
  activities,
  usedSources,
  onViewSources,
}: {
  activities: WebToolActivity[];
  /** Indexes the message lists as sources; absent counts every hit. */
  usedSources?: ReadonlySet<number>;
  onViewSources?: () => void;
}) {
  const anyRunning = activities.some((activity) => activity.status === "running");
  // Keep the disclosure open briefly across the tiny gap between a completed
  // search call and the next page-read call. Without the grace period, fast
  // research sequences visibly collapse and reopen between model turns.
  const [previousRunning, setPreviousRunning] = useState(anyRunning);
  const [graceOpen, setGraceOpen] = useState(anyRunning);
  if (previousRunning !== anyRunning) {
    setPreviousRunning(anyRunning);
    if (anyRunning) setGraceOpen(true);
  }
  useEffect(() => {
    if (anyRunning || !graceOpen) return;

    const timeout = window.setTimeout(() => setGraceOpen(false), COLLAPSE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [anyRunning, graceOpen]);

  // A manual choice applies to its current phase. Carry a manual collapse into
  // the completion grace period so finishing never reopens something the user
  // explicitly closed.
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const manuallyCollapsedWhileRunning =
    override?.during === true && override.value === false && !anyRunning;
  const expanded =
    override !== null && override.during === anyRunning
      ? override.value
      : manuallyCollapsedWhileRunning
        ? false
        : anyRunning || graceOpen;

  if (activities.length === 0) return null;

  const searches = activities.filter((activity) => activity.name !== "read_url");
  const reads = activities.filter((activity) => activity.name === "read_url");
  const queries = uniqueTargets(activities);
  const pages = openedPages(activities);
  const sourceCount = uniqueSourceCount(activities, usedSources);
  const failedPages = pages.filter((page) => page.status === "error").length;
  const failedSearches = searches.filter((activity) => activity.status === "error").length;
  const failedReads = reads.filter((activity) => activity.status === "error").length;
  const reading = pages.some((page) => page.status === "reading");
  const readsRunning = reads.some((activity) => activity.status === "running");
  const allFailed = activities.every((activity) => activity.status === "error");

  const suffix =
    sourceCount > 0 ? ` · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : "";
  const headerLabel = anyRunning
    ? reading
      ? "Reading sources…"
      : readsRunning
        ? "Opening sources…"
        : "Searching the web…"
    : allFailed
      ? searches.length > 0
        ? "Web search failed"
        : "Couldn’t read pages"
      : searches.length > 0
        ? `Searched the web${suffix}`
        : `Read ${pages.length === 1 ? "a page" : `${pages.length} pages`}${suffix}`;

  let orderedPages = pages;
  if (anyRunning) {
    orderedPages = [...pages];
    // oxlint-disable-next-line no-array-sort -- sorting a fresh copy for running priority
    orderedPages.sort((a, b) => pagePriority[a.status] - pagePriority[b.status]);
  }
  const visiblePages = orderedPages.slice(0, PAGE_LIMIT);
  const hiddenPages = pages.length - visiblePages.length;
  const hasDetails =
    queries.length > 0 ||
    pages.length > 0 ||
    failedSearches > 0 ||
    failedReads > 0 ||
    (onViewSources !== undefined && sourceCount > 0);

  return (
    <Disclosure
      open={expanded}
      onOpenChange={(next) => setOverride({ during: anyRunning, value: next })}
      className="mb-2"
    >
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={GlobalSearchIcon} className="size-4" aria-hidden />
        <span className={cn(anyRunning && "text-shimmer")}>{headerLabel}</span>
        {hasDetails ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            className={cn(disclosureChevronMotionClassName, "size-3.5", expanded && "rotate-180")}
          />
        ) : null}
      </DisclosureTrigger>
      {hasDetails ? (
        <DisclosureContent>
          <div className={cn(disclosureBodyRailClassName, "flex flex-col gap-2")}>
            {queries.length > 0 ? (
              <p>
                Searched <span className="text-foreground/70">{quotedTargets(queries)}</span>
              </p>
            ) : null}
            {pages.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <p>Opened {pages.length === 1 ? "a page" : `${pages.length} pages`}</p>
                <ul className="flex flex-col gap-1 pl-0.5">
                  {visiblePages.map((page) => (
                    <PageRow key={urlKey(page.url)} page={page} active={anyRunning} />
                  ))}
                </ul>
                {hiddenPages > 0 ? (
                  <p className="text-muted-foreground/70 text-xs">+{hiddenPages} more opened</p>
                ) : null}
              </div>
            ) : null}
            {failedSearches > 0 ? (
              <p className="text-destructive text-xs">
                {failedSearches === 1 ? "A search failed." : `${failedSearches} searches failed.`}
              </p>
            ) : null}
            {failedReads > 0 && failedPages === 0 ? (
              <p className="text-destructive text-xs">Some sources couldn’t be opened.</p>
            ) : null}
            {onViewSources && sourceCount > 0 && !anyRunning ? (
              <button
                type="button"
                onClick={onViewSources}
                className="text-foreground hover:text-primary w-fit text-xs font-medium transition-colors"
              >
                View all sources
              </button>
            ) : null}
          </div>
        </DisclosureContent>
      ) : null}
    </Disclosure>
  );
}
