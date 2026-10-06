import {
  BubbleChatIcon,
  Delete02Icon,
  MoreHorizontalIcon,
  PlayIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useStore } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useBlocker, useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useId, useState } from "react";
import { toast } from "sonner";
import { scheduleAuthoringRequest } from "../authoring.ts";
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
import { useConfirm } from "~/ui/confirm-context.ts";
import { SaveLabel, SaveStatus } from "~/ui/save-status.tsx";
import { useSaveStatus } from "~/ui/use-save-status.ts";
import { useAppForm } from "~/ui/form/app-form.ts";
import { ErrorState, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { toastError } from "~/ui/error-toast.ts";
import type { IntegrationGrant } from "~/modules/integrations/grant.ts";

/** Today's runs by clock time, older ones by day, like the chats list. */
const runStamp = (date: Date) => {
  const day = dayLabel(date);
  return day === "Today" ? clockLabel(date) : day;
};

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
  chatMode: "new" | "same";
  chatId: string | null;
  integrationGrants: ReadonlyArray<IntegrationGrant>;
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
  chatMode: schedule.chatMode,
  chatId: schedule.chatId,
  integrationGrants: schedule.integrationGrants.map((grant) => ({ ...grant })),
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
    onError: (error) => toastError("Could not pause the schedule.", error),
  });
  const resume = useMutation({
    mutationFn: () => resumeSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not resume the schedule.", error),
  });
  const runNow = useMutation({
    mutationFn: () => runScheduleNow({ data: { scheduleId } }),
    onSuccess: () => {
      toast.success("Run started.");
      void invalidate();
    },
    onError: (error) => toastError("Could not start a run.", error),
  });
  const remove = useMutation({
    mutationFn: () => deleteSchedule({ data: { scheduleId } }),
    onError: (error) => toastError("Could not delete the schedule.", error),
  });
  const formId = useId();
  const form = useAppForm({
    defaultValues: scheduleToSettings(schedule),
    validators: { onSubmit: Schema.toStandardSchemaV1(ScheduleSettings) },
    onSubmit: async ({ value, formApi }) => {
      try {
        await updateSchedule({ data: { scheduleId, settings: value } });
        // Confirm before the reset: resetting ends the submit, and in between
        // the button would show its idle label for a moment.
        markSaved();
        if (JSON.stringify(formApi.state.values) === JSON.stringify(value))
          formApi.reset(value, { keepDefaultValues: true });
        await invalidate();
      } catch (error) {
        toastError("Could not save the schedule.", error);
      }
    },
  });
  const dirty = useStore(form.store, (state) => state.isDirty);
  const [startingRun, setStartingRun] = useState(false);
  const { justSaved, markSaved } = useSaveStatus();
  const submitting = useStore(form.store, (state) => state.isSubmitting);
  // Same guard as the agent and skill editors; a successful save resets the
  // form, so `dirty` is also "not yet saved".
  useBlocker({
    shouldBlockFn: async () =>
      dirty &&
      !submitting &&
      !(await confirm({
        title: "Discard unsaved changes?",
        description: "Your schedule has not been saved.",
        confirmLabel: "Discard changes",
      })),
    enableBeforeUnload: dirty,
  });
  return (
    <Page
      title={schedule.name}
      backTo="/schedules"
      backLabel="Schedules"
      actions={
        <>
          <SaveStatus justSaved={justSaved} />
          <Button
            size="sm"
            variant="outline"
            disabled={pause.isPending || resume.isPending}
            onClick={() => (schedule.paused ? resume.mutate() : pause.mutate())}
          >
            {schedule.paused ? "Resume" : "Pause"}
          </Button>
          {/* A run uses the saved schedule, so with edits pending it saves
              first and runs only if that save went through: what runs is
              always what is on screen. The label stays put; Save beside it
              turning to "Saved" shows the save happened. */}
          <PendingButton
            size="sm"
            variant="outline"
            title={dirty ? "Saves your changes, then runs" : undefined}
            pending={runNow.isPending || startingRun}
            onClick={() => {
              setStartingRun(true);
              void (async () => {
                try {
                  if (form.state.isDirty) {
                    await form.handleSubmit();
                    if (form.state.isDirty) return;
                  }
                  runNow.mutate();
                } finally {
                  setStartingRun(false);
                }
              })();
            }}
          >
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
            Run now
          </PendingButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label="Schedule actions" />}
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                render={
                  <Link
                    to="/"
                    search={{}}
                    state={{ chatPrefill: scheduleAuthoringRequest(scheduleId) }}
                  />
                }
              >
                <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} />
                Edit with chat
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* A menu item closes on activation, so it cannot carry a
                spinner; disabling it is the pending signal. */}
              <DropdownMenuItem
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  void confirm({
                    title: `Delete “${schedule.name}”?`,
                    description: "No future runs will fire. Its chats stay in your chat list.",
                    confirmLabel: "Delete schedule",
                  }).then(async (confirmed) => {
                    if (!confirmed) return;
                    try {
                      await remove.mutateAsync();
                      await queryClient.invalidateQueries({ queryKey: ["schedules"] });
                      await navigate({ to: "/schedules", ignoreBlocker: true });
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
            <form.SubmitButton size="sm" form={formId} disabled={!dirty}>
              <SaveLabel justSaved={justSaved}>Save changes</SaveLabel>
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
                      : run.status === "pending"
                        ? "Starting scheduled chat…"
                        : run.status === "skipped"
                          ? (run.error ?? "Skipped")
                          : (run.error ?? "Could not run")}
                  </span>
                  {run.status === "pending" ? <Badge variant="secondary">Pending</Badge> : null}
                  {run.status === "error" ? <Badge variant="destructive">Failed</Badge> : null}
                  {run.status === "skipped" ? <Badge variant="secondary">Skipped</Badge> : null}
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
