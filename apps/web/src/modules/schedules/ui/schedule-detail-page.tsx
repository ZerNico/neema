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
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { scheduleAuthoringRequest } from "../authoring.ts";
import { scheduleQuery, scheduleRunsQuery } from "../client/queries.ts";
import { ScheduleSettings, scheduleToSettings } from "../schema.ts";
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
import { FieldError } from "~/ui/primitives/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";
import { formatLocale } from "~/i18n/formats.ts";

/** Today's runs by clock time, older ones by day, like the chats list. */
const runStamp = (date: Date) => {
  const now = new Date();
  return date.toDateString() === now.toDateString()
    ? clockLabel(date, formatLocale())
    : dayLabel(date, now, formatLocale());
};

export function ScheduleDetailPage({ scheduleId }: { scheduleId: string }) {
  const detail = useQuery({ ...scheduleQuery(scheduleId), retry: false });
  if (detail.isError)
    return (
      <Page title={m.schedules_detail_title()} backTo="/schedules" backLabel={m.schedules_title()}>
        <ErrorState
          title={m.schedules_detail_load_failed()}
          description={m.schedules_detail_load_failed_description()}
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
    onError: (error) => toastError(m.schedules_detail_pause_failed(), error),
  });
  const resume = useMutation({
    mutationFn: () => resumeSchedule({ data: { scheduleId } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.schedules_detail_resume_failed(), error),
  });
  const runNow = useMutation({
    mutationFn: () => runScheduleNow({ data: { scheduleId } }),
    onSuccess: () => {
      toast.success(m.schedules_detail_run_started());
      void invalidate();
    },
    onError: (error) => toastError(m.schedules_detail_run_failed(), error),
  });
  const remove = useMutation({
    mutationFn: () => deleteSchedule({ data: { scheduleId } }),
    onError: (error) => toastError(m.schedules_detail_delete_failed(), error),
  });
  const formId = useId();
  // Dirty values keep the revision they came from, not the latest query's: a
  // fire adopting its chat moves it too, and a save must not write that back.
  const revision = useRef(schedule.configRevision);
  const form = useAppForm({
    defaultValues: scheduleToSettings(schedule),
    validators: { onSubmit: Schema.toStandardSchemaV1(ScheduleSettings) },
    onSubmit: async ({ value, formApi }) => {
      try {
        const saved = await updateSchedule({
          data: { scheduleId, expectedRevision: revision.current, settings: value },
        });
        revision.current = saved.configRevision;
        // Confirm before the reset: resetting ends the submit, and in between
        // the button would show its idle label for a moment.
        markSaved();
        if (JSON.stringify(formApi.state.values) === JSON.stringify(value))
          formApi.reset(value, { keepDefaultValues: true });
        await invalidate();
      } catch (error) {
        toastError(m.schedules_detail_save_failed(), error);
      }
    },
  });
  const dirty = useStore(form.store, (state) => state.isDirty);
  const externalChange = useStore(
    form.store,
    (state) => state.isDirty && schedule.configRevision !== revision.current,
  );
  useEffect(() => {
    if (schedule.configRevision === revision.current || form.state.isDirty) return;
    revision.current = schedule.configRevision;
    form.reset(scheduleToSettings(schedule), { keepDefaultValues: true });
  }, [schedule, form]);
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
        title: m.common_discard_title(),
        description: m.schedules_unsaved_description(),
        confirmLabel: m.common_discard_changes(),
      })),
    enableBeforeUnload: dirty,
  });
  return (
    <Page
      title={schedule.name}
      backTo="/schedules"
      backLabel={m.schedules_title()}
      actions={
        <>
          <SaveStatus justSaved={justSaved} />
          <Button
            size="sm"
            variant="outline"
            disabled={pause.isPending || resume.isPending}
            onClick={() => (schedule.paused ? resume.mutate() : pause.mutate())}
          >
            {schedule.paused ? m.schedules_detail_resume() : m.schedules_detail_pause()}
          </Button>
          {/* A run uses the saved schedule, so with edits pending it saves
              first and runs only if that save went through: what runs is
              always what is on screen. The label stays put; Save beside it
              turning to "Saved" shows the save happened. */}
          <PendingButton
            size="sm"
            variant="outline"
            title={dirty ? m.schedules_detail_run_saves_first() : undefined}
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
            {m.schedules_detail_run_now()}
          </PendingButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button size="icon-sm" variant="ghost" aria-label={m.schedules_detail_actions()} />
              }
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
                {m.schedules_detail_edit_with_chat()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* A menu item closes on activation, so it cannot carry a
                spinner; disabling it is the pending signal. */}
              <DropdownMenuItem
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => {
                  void confirm({
                    title: m.schedules_detail_delete_title({ name: schedule.name }),
                    description: m.schedules_detail_delete_description(),
                    confirmLabel: m.schedules_detail_delete(),
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
                {m.schedules_detail_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <form.AppForm>
            <form.SubmitButton size="sm" form={formId} disabled={!dirty}>
              <SaveLabel justSaved={justSaved}>{m.common_save_changes()}</SaveLabel>
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
        {externalChange ? (
          <div className="space-y-2">
            <FieldError>{m.schedules_detail_changed_elsewhere()}</FieldError>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                revision.current = schedule.configRevision;
                form.reset(scheduleToSettings(schedule), { keepDefaultValues: true });
              }}
            >
              {m.schedules_detail_reload()}
            </Button>
          </div>
        ) : null}
        <ScheduleSettingsFields form={form} />
      </form>
      <Section title={m.schedules_runs_title()}>
        {runs.isError ? (
          <ErrorState
            title={m.schedules_runs_load_failed()}
            onRetry={() => {
              void runs.refetch();
            }}
          />
        ) : runs.data === undefined ? (
          <ListSkeleton rows={3} media="none" label={m.schedules_runs_loading()} />
        ) : runs.data.runs.length === 0 ? (
          <p className="text-muted-foreground text-sm">{m.schedules_runs_empty()}</p>
        ) : (
          // The chats page's idiom: whole-row links with a hover surface and
          // the time on the right, since each run is a chat.
          <ul className="-mx-3 flex flex-col">
            {runs.data.runs.map((run) => {
              const content = (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {run.conversationId
                      ? (run.conversationTitle ?? m.schedules_runs_untitled_chat())
                      : run.status === "pending"
                        ? m.schedules_runs_starting()
                        : run.status === "skipped"
                          ? (run.error ?? m.schedules_runs_skipped())
                          : (run.error ?? m.schedules_runs_could_not_run())}
                  </span>
                  {run.status === "pending" ? (
                    <Badge variant="secondary">{m.schedules_runs_pending()}</Badge>
                  ) : null}
                  {run.status === "error" ? (
                    <Badge variant="destructive">{m.schedules_runs_failed()}</Badge>
                  ) : null}
                  {run.status === "skipped" ? (
                    <Badge variant="secondary">{m.schedules_runs_skipped()}</Badge>
                  ) : null}
                  <time
                    dateTime={new Date(run.firedAt).toISOString()}
                    title={absoluteLabel(new Date(run.firedAt), formatLocale())}
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
