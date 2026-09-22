import { Delete02Icon, MoreHorizontalIcon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useId } from "react";
import { toast } from "sonner";
import { scheduleQuery, scheduleRunsQuery } from "../client/queries.ts";
import { ScheduleSettings } from "../schema.ts";
import {
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  updateSchedule,
} from "../server/functions.ts";
import { ScheduleSettingsFields } from "./schedule-settings-fields.tsx";
import { absoluteLabel, clockLabel, dayLabel } from "~/modules/chat/ui/timestamps.ts";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { cn } from "~/ui/utils";
import { useConfirm } from "~/ui/confirm.tsx";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { ErrorState, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

/** Today's runs by clock time, older ones by day, like the chats list. */
const runStamp = (date: Date) => {
  const day = dayLabel(date);
  return day === "Today" ? clockLabel(date) : day;
};

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const scheduleToSettings = (schedule: {
  name: string;
  scheduleText: string;
  cron: string;
  timezone: string;
  endAt: Date | null;
  prompt: string;
  modelId: string | null;
  agentId: string | null;
  searchEnabled: boolean;
  researchEnabled: boolean;
  collectionIds: string[];
  skillIds: string[];
}): ScheduleSettings => ({
  name: schedule.name,
  scheduleText: schedule.scheduleText,
  cron: schedule.cron,
  timezone: schedule.timezone,
  endAt: schedule.endAt ? schedule.endAt.toISOString() : null,
  prompt: schedule.prompt,
  modelId: schedule.modelId,
  agentId: schedule.agentId,
  searchEnabled: schedule.searchEnabled,
  researchEnabled: schedule.researchEnabled,
  collectionIds: [...schedule.collectionIds],
  skillIds: [...schedule.skillIds],
});

export function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const detail = useQuery({ ...scheduleQuery(scheduleId), retry: false });
  if (detail.isError)
    return (
      <Page title="Schedule" backTo="/schedules" backLabel="Schedules">
        <ErrorState
          title="Could not load this schedule"
          description="It may have been deleted."
          onRetry={() => {
            void detail.refetch();
          }}
        />
      </Page>
    );
  if (!detail.data) return null;
  // Keyed remount: the form's defaultValues are captured at mount, so only a
  // resolved row can seed one; navigating between schedules starts fresh.
  return <ScheduleDetail key={scheduleId} scheduleId={scheduleId} />;
}

function ScheduleDetail({ scheduleId }: { scheduleId: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  // The parent rendered only once detail resolved, so this suspends to the
  // same cache entry.
  const { data: schedule } = useSuspenseQuery(scheduleQuery(scheduleId));
  const runs = useQuery(scheduleRunsQuery(scheduleId));
  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["schedules"] }),
      queryClient.invalidateQueries({ queryKey: ["schedule", scheduleId] }),
      queryClient.invalidateQueries({ queryKey: ["schedule-runs", scheduleId] }),
    ]);
  const pause = useMutation({
    mutationFn: () => pauseSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not pause the schedule."),
  });
  const resume = useMutation({
    mutationFn: () => resumeSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not resume the schedule."),
  });
  const runNow = useMutation({
    mutationFn: () => runScheduleNow({ data: { scheduleId } }),
    onSuccess: () => {
      toast.success("Run started.");
      void invalidate();
    },
    onError: () => toast.error("Could not start a run."),
  });
  const remove = useMutation({
    mutationFn: () => deleteSchedule({ data: { scheduleId } }),
    onError: () => toast.error("Could not delete the schedule."),
  });
  const formId = useId();
  const form = useAppForm({
    defaultValues: scheduleToSettings(schedule),
    validators: { onSubmit: Schema.toStandardSchemaV1(ScheduleSettings) },
    onSubmit: async ({ value, formApi }) => {
      try {
        await updateSchedule({ data: { scheduleId, settings: value } });
        if (JSON.stringify(formApi.state.values) === JSON.stringify(value))
          formApi.reset(value, { keepDefaultValues: true });
        await invalidate();
        toast.success("Schedule saved.");
      } catch (error) {
        toast.error(message(error, "Could not save the schedule."));
      }
    },
  });
  const dirty = useStore(form.store, (state) => state.isDirty);
  return (
    <Page
      title={schedule.name}
      backTo="/schedules"
      backLabel="Schedules"
      actions={
        <>
          {dirty ? <span className="text-muted-foreground text-xs">Unsaved changes</span> : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pause.isPending || resume.isPending}
            onClick={() => (schedule.paused ? resume.mutate() : pause.mutate())}
          >
            {schedule.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
            Run now
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Schedule actions" />}
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* A menu item closes on activation, so it cannot carry a
                spinner; disabling it is the pending signal. */}
              <DropdownMenuItem
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  void confirm({
                    title: `Delete “${schedule.name}”?`,
                    description:
                      "Its past run conversations are deleted with it. No future runs will fire.",
                    confirmLabel: "Delete schedule",
                  }).then(async (confirmed) => {
                    if (!confirmed) return;
                    try {
                      await remove.mutateAsync();
                      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
                      await navigate({ to: "/schedules" });
                    } catch {
                      // remove.onError already toasted
                    }
                  });
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <form.AppForm>
            <form.SubmitButton size="sm" form={formId}>
              Save changes
            </form.SubmitButton>
          </form.AppForm>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <ScheduleSettingsFields form={form} />
      </form>
      <Section title="Runs">
        {runs.isError ? (
          <ErrorState
            title="Could not load runs"
            onRetry={() => {
              void runs.refetch();
            }}
          />
        ) : runs.data === undefined ? (
          <ListSkeleton rows={3} media="none" label="Loading runs" />
        ) : runs.data.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">No runs yet.</p>
        ) : (
          // The chats page's idiom: whole-row links with a hover surface and
          // the time on the right, since each run is a chat.
          <ul className="-mx-3 flex flex-col">
            {runs.data.runs.map((run) => {
              const content = (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {run.conversationId
                      ? (run.conversationTitle ?? "Untitled chat")
                      : (run.error ?? "Could not run")}
                  </span>
                  {run.status === "error" ? <Badge variant="destructive">Failed</Badge> : null}
                  <time
                    dateTime={new Date(run.firedAt).toISOString()}
                    title={absoluteLabel(new Date(run.firedAt))}
                    className="text-muted-foreground shrink-0 text-xs tabular-nums"
                  >
                    {runStamp(new Date(run.firedAt))}
                  </time>
                </>
              );
              const row = "flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-sm";
              return (
                <li key={run.id}>
                  {run.conversationId ? (
                    <Link
                      to="/chat/$conversationId"
                      params={{ conversationId: run.conversationId }}
                      className={cn(
                        focusRingClassName,
                        row,
                        "hover:bg-accent hover:text-accent-foreground transition-colors",
                      )}
                    >
                      {content}
                    </Link>
                  ) : (
                    <div className={cn(row, "text-muted-foreground")}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
    </Page>
  );
}
