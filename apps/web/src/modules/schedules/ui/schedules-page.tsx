import {
  Calendar03Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { schedulesQuery } from "../client/queries.ts";
import type { ScheduleSummary } from "../schema.ts";
import { deleteSchedule, pauseSchedule, resumeSchedule } from "../server/functions.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { EmptyState, ErrorState, ListCard, ListRow, ListSkeleton, Page } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

const nextFireLabel = (schedule: ScheduleSummary) => {
  if (schedule.paused) return "Paused";
  if (!schedule.nextFireAt) return "No upcoming run";
  const next = new Date(schedule.nextFireAt);
  return next.getTime() <= Date.now() ? "Due now" : `Next run ${relativeAgeLabel(next)}`;
};

export function SchedulesPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const schedules = useQuery(schedulesQuery);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["schedules"] });
  const pause = useMutation({
    mutationFn: (scheduleId: string) => pauseSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not pause the schedule."),
  });
  const resume = useMutation({
    mutationFn: (scheduleId: string) => resumeSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not resume the schedule."),
  });
  const remove = useMutation({
    mutationFn: (scheduleId: string) => deleteSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not delete the schedule."),
  });
  const rows = schedules.data ?? [];
  return (
    <Page
      title="Schedules"
      rootPath="/"
      rootLabel="Chat"
      actions={
        <Link
          to="/"
          className={buttonVariants({ size: "sm" })}
          state={{
            chatPrefill:
              "Help me set up a scheduled task. Ask what it should do and how often, then prepare a draft for me to review before it goes live.",
          }}
        >
          <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} data-icon="inline-start" />
          New schedule
        </Link>
      }
    >
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
        />
      ) : (
        <ListCard>
          {rows.map((schedule) => (
            <ListRow key={schedule.id}>
              <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4" />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="truncate">{schedule.name}</span>
                  {schedule.paused ? <Badge variant="outline">Paused</Badge> : null}
                </span>
                <span className="text-muted-foreground truncate text-xs">
                  {schedule.scheduleText} · {nextFireLabel(schedule)}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pause.isPending || resume.isPending}
                onClick={() =>
                  schedule.paused ? resume.mutate(schedule.id) : pause.mutate(schedule.id)
                }
              >
                {schedule.paused ? "Resume" : "Pause"}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Actions for ${schedule.name}`}
                    />
                  }
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    render={
                      <Link to="/schedules/$scheduleId" params={{ scheduleId: schedule.id }} />
                    }
                  >
                    <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={remove.isPending}
                    onClick={() => {
                      void confirm({
                        title: `Delete “${schedule.name}”?`,
                        description:
                          "Its past run conversations are deleted with it. No future runs will fire.",
                        confirmLabel: "Delete schedule",
                      }).then((confirmed) => {
                        if (confirmed) remove.mutate(schedule.id);
                      });
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ListRow>
          ))}
        </ListCard>
      )}
    </Page>
  );
}
