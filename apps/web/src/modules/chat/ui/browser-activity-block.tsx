import { Globe02Icon } from "@hugeicons/core-free-icons";
import { BROWSER_ACTIVITY } from "~/modules/browser/ui/browser-activity.ts";
import { isBrowserTool } from "~/modules/browser/tool-schema.ts";
import type { DesktopToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { Favicon } from "./favicon.tsx";
import { hostOf } from "./host-of.ts";

type Page = { url: string; title: string };

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
 * A run of browser calls as the steps themselves, one line each, with each
 * page linked where it was reached. It always sits in a work line, whose header
 * says what the work came to; a header of its own would only repeat it, and
 * while running would flash each step and fall back to "Browsed …" between
 * them. A step waiting on the user is asked about above the composer.
 */
export function BrowserActivityBlock({
  activities,
  pageBefore,
}: {
  activities: DesktopToolActivity[];
  /** Where the answer's browsing stood before this run: a round's thinking splits one session. */
  pageBefore?: string | undefined;
}) {
  if (activities.length === 0) return null;
  // A page is linked where the answer first reached it, not on every step there.
  const steps = activities.map((activity, index) => {
    const page = activity.result?.page ?? null;
    const previous =
      activities.slice(0, index).findLast((call) => call.result?.page)?.result?.page?.url ??
      pageBefore;
    return { activity, reached: page && page.url !== previous ? page : null };
  });
  return (
    <ol className="mb-2 flex flex-col gap-1.5">
      {steps.map(({ activity, reached }) => {
        const icon = isBrowserTool(activity.name)
          ? BROWSER_ACTIVITY[activity.name].icon
          : Globe02Icon;
        return (
          <li key={activity.callId} className="flex min-w-0 flex-col gap-1">
            <span className={activityRowClassName}>
              <ActivityFace
                icon={icon}
                label={lineOf(activity)}
                status={
                  activity.status === "running"
                    ? "running"
                    : activity.status === "error"
                      ? "failed"
                      : "done"
                }
              />
            </span>
            {reached ? <PageLink page={reached} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
