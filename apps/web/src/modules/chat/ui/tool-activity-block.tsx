import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  GlobalSearchIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
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
import { Badge } from "~/ui/primitives/badge";
import { cn } from "~/ui/utils";

const QUERY_LIMIT = 4;
const PAGE_LIMIT = 4;
const STACK_LIMIT = 4;

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

/** The web sources the answer kept, one per page; absent `used` keeps every hit. */
const keptSourceUrls = (
  activities: ReadonlyArray<WebToolActivity>,
  used: ReadonlySet<number> | undefined,
): string[] => {
  const urls = new Map<string, string>();
  for (const activity of activities) {
    for (const source of activity.sources ?? []) {
      if (used && !used.has(source.index)) continue;
      if (source.kind !== "document") urls.set(urlKey(source.url), source.url);
    }
  }
  return [...urls.values()];
};

/** One icon per site, kept sources first, then pages that opened. */
const stackHosts = (sourceUrls: ReadonlyArray<string>, pages: ReadonlyArray<ToolPageStatus>) => {
  const hosts = new Map<string, string>();
  const candidates = [
    ...sourceUrls,
    ...pages.filter((page) => page.status !== "error").map((page) => page.url),
  ];
  for (const url of candidates) {
    const host = hostOf(url);
    if (!hosts.has(host)) hosts.set(host, url);
  }
  return [...hosts.values()].slice(0, STACK_LIMIT);
};

function FaviconStack({ urls }: { urls: ReadonlyArray<string> }) {
  if (urls.length === 0)
    return <HugeiconsIcon icon={GlobalSearchIcon} strokeWidth={2} className="size-4" aria-hidden />;
  return (
    <span className="flex shrink-0 items-center" aria-hidden>
      {urls.map((url, index) => (
        <span
          key={hostOf(url)}
          className={cn(
            "bg-muted border-border ring-background flex size-[18px] items-center justify-center rounded-full border ring-2",
            index > 0 && "-ml-1.5",
          )}
        >
          <Favicon url={url} className="size-3.5 rounded-full" />
        </span>
      ))}
    </span>
  );
}

function PageRow({ page, active }: { page: ToolPageStatus; active: boolean }) {
  const label = page.title?.trim() || hostOf(page.url);
  const failed = page.status === "error";
  return (
    <li className="flex min-w-0 items-center gap-2">
      <Favicon url={page.url} className={cn(failed && "opacity-50")} />
      <a
        href={page.url}
        target="_blank"
        rel="noreferrer noopener"
        className={cn(
          "text-foreground/80 hover:text-foreground min-w-0 truncate transition-colors",
          active && page.status === "reading" && "text-shimmer",
          active && page.status === "pending" && "text-muted-foreground/60",
          failed && "text-muted-foreground",
        )}
        title={page.error ?? page.url}
      >
        {label}
      </a>
      {failed ? (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs">
          <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} className="text-warning size-3.5" />
          Couldn’t open
        </span>
      ) : (
        <span className="text-muted-foreground/70 hidden shrink-0 text-xs sm:inline">
          {hostOf(page.url)}
        </span>
      )}
    </li>
  );
}

const pagePriority: Record<ToolPageStatus["status"], number> = {
  reading: 0,
  pending: 1,
  error: 2,
  done: 3,
};

const websites = (count: number) => (count === 1 ? "a website" : `${count} websites`);

/**
 * One search-and-read step, written for people who do not care which tool
 * ran: what it is looking for or reading now, then the sites it used. It
 * never opens by itself; the work line around it already shows it is busy.
 */
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
  const [expanded, setExpanded] = useState(false);
  const [showAllPages, setShowAllPages] = useState(false);

  if (activities.length === 0) return null;

  const searches = activities.filter((activity) => activity.name !== "read_url");
  const reads = activities.filter((activity) => activity.name === "read_url");
  const queries = uniqueTargets(activities);
  const pages = openedPages(activities);
  const sourceUrls = keptSourceUrls(activities, usedSources);
  const sourceCount = sourceUrls.length;
  const failedSearches = searches.filter((activity) => activity.status === "error").length;
  const anyRunning = activities.some((activity) => activity.status === "running");
  const allFailed = activities.every((activity) => activity.status === "error");
  const readingNow = pages.filter((page) => page.status === "reading");
  const waiting = pages.filter((page) => page.status === "pending");
  const runningQuery = searches
    .filter((activity) => activity.status === "running")
    .flatMap((activity) => activity.targets)
    .at(-1)
    ?.trim();

  const suffix =
    sourceCount > 0 ? ` · ${sourceCount} ${sourceCount === 1 ? "source" : "sources"}` : "";
  const headerLabel = anyRunning
    ? readingNow.length > 0
      ? `Reading ${readingNow.length === 1 ? hostOf(readingNow[0]!.url) : websites(readingNow.length)}`
      : reads.some((activity) => activity.status === "running")
        ? `Opening ${waiting.length === 1 ? hostOf(waiting[0]!.url) : waiting.length > 1 ? websites(waiting.length) : "websites"}`
        : runningQuery
          ? `Searching for “${runningQuery}”`
          : "Searching the web"
    : allFailed
      ? searches.length > 0
        ? "Couldn’t search the web"
        : "Couldn’t open the pages"
      : searches.length > 0
        ? `Searched the web${suffix}`
        : `Read ${pages.length === 1 ? "a page" : `${pages.length} pages`}${suffix}`;

  let orderedPages = pages;
  if (anyRunning) {
    orderedPages = [...pages];
    // oxlint-disable-next-line no-array-sort -- sorting a fresh copy for running priority
    orderedPages.sort((a, b) => pagePriority[a.status] - pagePriority[b.status]);
  }
  const visiblePages = showAllPages ? orderedPages : orderedPages.slice(0, PAGE_LIMIT);
  const hiddenPages = pages.length - visiblePages.length;
  const hiddenQueries = queries.length - QUERY_LIMIT;
  const canViewSources = onViewSources !== undefined && sourceCount > 0 && !anyRunning;
  const hasDetails = queries.length > 0 || pages.length > 0 || failedSearches > 0 || canViewSources;

  return (
    <Disclosure open={expanded} onOpenChange={setExpanded} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <FaviconStack urls={stackHosts(sourceUrls, pages)} />
        <span className={cn("min-w-0 truncate", anyRunning && "text-shimmer")}>{headerLabel}</span>
        {hasDetails ? (
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            strokeWidth={2}
            className={cn(
              disclosureChevronMotionClassName,
              "size-3.5 shrink-0",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        ) : null}
      </DisclosureTrigger>
      {hasDetails ? (
        <DisclosureContent>
          <div className={cn(disclosureBodyRailClassName, "flex flex-col gap-3")}>
            {queries.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Searches">
                {queries.slice(0, QUERY_LIMIT).map((query) => (
                  <li key={query} className="max-w-full">
                    <Badge variant="secondary" className="max-w-full">
                      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} data-icon="inline-start" />
                      <span className="truncate">{query}</span>
                    </Badge>
                  </li>
                ))}
                {hiddenQueries > 0 ? (
                  <li>
                    <Badge variant="outline">+{hiddenQueries} more</Badge>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {pages.length > 0 ? (
              <ul className="flex flex-col gap-1.5" aria-label="Pages read">
                {visiblePages.map((page) => (
                  <PageRow key={urlKey(page.url)} page={page} active={anyRunning} />
                ))}
                {hiddenPages > 0 ? (
                  <li>
                    <button
                      type="button"
                      onClick={() => setShowAllPages(true)}
                      className="hover:text-foreground text-xs transition-colors"
                    >
                      Show {hiddenPages} more
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
            {failedSearches > 0 && !allFailed ? (
              <p className="text-xs">
                {failedSearches === 1
                  ? "One search didn’t work."
                  : `${failedSearches} searches didn’t work.`}
              </p>
            ) : null}
            {canViewSources ? (
              <button
                type="button"
                onClick={onViewSources}
                className="text-foreground hover:text-primary flex w-fit items-center gap-1 text-xs font-medium transition-colors"
              >
                View all sources
                <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
              </button>
            ) : null}
          </div>
        </DisclosureContent>
      ) : null}
    </Disclosure>
  );
}
