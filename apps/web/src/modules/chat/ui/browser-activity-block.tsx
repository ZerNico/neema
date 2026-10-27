import { m } from "~/paraglide/messages.js";
import { Alert02Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { BROWSER_ACTIVITY } from "~/modules/browser/ui/browser-activity.ts";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import type { DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import { ActivityChevron, ActivityFace } from "./activity-face.tsx";
import { Favicon } from "./favicon.tsx";
import { hostOf } from "./host-of.ts";

type Page = { url: string; title: string };

// "Browsed example.com", "… example.com and iana.org", "… example.com and 2 other sites".
const browsed = (sites: ReadonlyArray<string>) =>
  sites.length === 1
    ? m.chat_browser_browsed_one({ site: sites[0]! })
    : sites.length === 2
      ? m.chat_browser_browsed_two({ first: sites[0]!, second: sites[1]! })
      : m.chat_browser_browsed_many({ first: sites[0]!, count: sites.length - 1 });

const lineOf = (activity: DesktopToolActivity) =>
  activity.result?.summary ??
  (isBrowserTool(activity.name)
    ? BROWSER_ACTIVITY[activity.name].running(activity.args ?? {})
    : "");

function PageLink({ page }: { page: Page }) {
  return (
    <span className="flex min-w-0 items-center gap-2 pl-6">
      <Favicon url={page.url} />
      <a
        href={page.url}
        target="_blank"
        rel="noreferrer noopener"
        className="hover:text-foreground min-w-0 truncate transition-colors"
        title={page.url}
      >
        {page.title.trim() || hostOf(page.url)}
      </a>
      <span className="text-muted-foreground/70 hidden shrink-0 text-xs sm:inline">
        {hostOf(page.url)}
      </span>
    </span>
  );
}

/**
 * One collapsed row for a run of browser calls, like the web and knowledge
 * rows: the header says what happened in a few words, the disclosure lists the
 * steps as a person would put them, with each page linked as it was reached. A
 * step waiting on the user is asked about above the composer, not here.
 */
export function BrowserActivityBlock({
  activities,
  approvals,
}: {
  activities: DesktopToolActivity[];
  approvals?: ReadonlyMap<string, DesktopApprovalRequest> | undefined;
}) {
  const running = activities.find((activity) => activity.status === "running");
  const waiting = activities.find(
    (activity) => activity.status === "running" && approvals?.has(activity.callId),
  );
  // Folded until clicked: the work line around it is what opens while it runs.
  const [expanded, setExpanded] = useState(false);
  if (activities.length === 0) return null;

  const sites = [
    ...new Set(
      activities.flatMap((activity) => {
        const url = activity.result?.page?.url;
        return url ? [hostOf(url)] : [];
      }),
    ),
  ];
  const failed = activities.filter((activity) => activity.status === "error").length;
  const headerLabel = waiting
    ? m.chat_browser_waiting()
    : running
      ? lineOf(running)
      : failed === activities.length
        ? m.chat_browser_failed()
        : sites.length > 0
          ? browsed(sites)
          : m.chat_browser_used();

  // A page is linked where the run first reached it, not on every step there.
  const steps: Array<{ activity: DesktopToolActivity; reached: Page | null }> = [];
  for (const activity of activities) {
    const page = activity.result?.page ?? null;
    const previous = steps.findLast((step) => step.activity.result?.page)?.activity.result?.page;
    steps.push({ activity, reached: page && page.url !== previous?.url ? page : null });
  }
  return (
    <Disclosure open={expanded} onOpenChange={setExpanded} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <ActivityFace
          icon={Globe02Icon}
          label={headerLabel}
          status={
            waiting
              ? "waiting"
              : running
                ? "running"
                : failed === activities.length
                  ? "failed"
                  : "done"
          }
        />
        <ActivityChevron open={expanded} />
      </DisclosureTrigger>
      <DisclosureContent>
        <ol className={cn(disclosureBodyRailClassName, "flex flex-col gap-1.5")}>
          {steps.map(({ activity, reached }) => {
            const icon = isBrowserTool(activity.name)
              ? BROWSER_ACTIVITY[activity.name].icon
              : Globe02Icon;
            return (
              <li key={activity.callId} className="flex min-w-0 flex-col gap-1">
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-2",
                    activity.status === "running" && "text-shimmer",
                  )}
                >
                  <HugeiconsIcon
                    icon={activity.status === "error" ? Alert02Icon : icon}
                    strokeWidth={2}
                    className={cn("size-4 shrink-0", activity.status === "error" && "text-warning")}
                    aria-hidden
                  />
                  <span className="min-w-0 truncate">{lineOf(activity)}</span>
                </span>
                {reached ? <PageLink page={reached} /> : null}
              </li>
            );
          })}
        </ol>
      </DisclosureContent>
    </Disclosure>
  );
}
