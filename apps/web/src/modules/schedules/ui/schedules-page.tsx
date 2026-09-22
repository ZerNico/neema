import { ArrowRight01Icon, Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { cadenceText, parseCadence } from "../cadence.ts";
import { schedulesQuery } from "../client/queries.ts";
import type { ScheduleSummary } from "../schema.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { CreateSplitButton } from "~/ui/create-split-button.tsx";
import { EmptyState, ErrorState, ListCard, ListRow, ListSkeleton, Page } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";

const SCHEDULE_AUTHORING_REQUEST =
  "Help me set up a scheduled task. Ask what it should do and how often, then prepare a draft for me to review before it goes live.";

// A paused schedule already carries its badge; the line just drops the next run.
const nextFireLabel = (schedule: ScheduleSummary) => {
  if (schedule.paused) return null;
  if (!schedule.nextFireAt) return "No upcoming run";
  const next = new Date(schedule.nextFireAt);
  return next.getTime() <= Date.now() ? "Due now" : `Next run ${relativeAgeLabel(next)}`;
};

/** Named from the cron when the picker can read it, so a long day list stays one line. */
const cadenceLabel = (schedule: ScheduleSummary) =>
  cadenceText(parseCadence(schedule.cron), true) ?? schedule.scheduleText;

export function SchedulesPage() {
  const schedules = useQuery(schedulesQuery);
  const rows = schedules.data ?? [];
  const newSchedule = (
    <CreateSplitButton
      label="New schedule"
      chat={<Link to="/" search={{}} state={{ chatPrefill: SCHEDULE_AUTHORING_REQUEST }} />}
      manual={<Link to="/schedules/new" />}
    />
  );
  return (
    <Page title="Schedules" rootPath="/" rootLabel="Chat" actions={newSchedule}>
      {schedules.isError ? (
        <ErrorState
          title="Could not load schedules"
          onRetry={() => {
            void schedules.refetch();
          }}
        />
      ) : schedules.data === undefined ? (
        <ListSkeleton label="Loading schedules" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Calendar03Icon}
          title="No schedules yet"
          description="Ask in a chat to set one up, for example “every weekday at 7am, summarize the news”."
          action={newSchedule}
        />
      ) : (
        // Whole-row links like Knowledge: pausing, running and deleting live
        // on the schedule's page, one click away.
        <ListCard>
          {rows.map((schedule) => (
            <Link
              key={schedule.id}
              to="/schedules/$scheduleId"
              params={{ scheduleId: schedule.id }}
              aria-label={`Open ${schedule.name}`}
              className="block"
            >
              <ListRow interactive>
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                  <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate">{schedule.name}</span>
                    {schedule.paused ? <Badge variant="outline">Paused</Badge> : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {[cadenceLabel(schedule), nextFireLabel(schedule)].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="text-muted-foreground size-4 shrink-0"
                />
              </ListRow>
            </Link>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
