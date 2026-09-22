import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { useId } from "react";
import { toast } from "sonner";
import { DEFAULT_CADENCE, cadenceCron, cadenceText } from "../cadence.ts";
import { EMPTY_SCHEDULE_DRAFT } from "../draft-schema.ts";
import { ScheduleSettings } from "../schema.ts";
import { createSchedule } from "../server/functions.ts";
import { ScheduleSettingsFields } from "./schedule-settings-fields.tsx";
import { browserTimeZone } from "~/modules/chat/client/time-zone.ts";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { Page } from "~/ui/page-shell.tsx";

const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function ScheduleCreatePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const formId = useId();
  const form = useAppForm({
    // The reader's own zone is the likelier intent than the draft's UTC, and
    // a picked cadence beats an empty cron nobody asked to write.
    defaultValues: {
      ...EMPTY_SCHEDULE_DRAFT,
      cron: cadenceCron(DEFAULT_CADENCE),
      scheduleText: cadenceText(DEFAULT_CADENCE) ?? "",
      timezone: browserTimeZone(),
    },
    validators: { onSubmit: Schema.toStandardSchemaV1(ScheduleSettings) },
    onSubmit: async ({ value }) => {
      try {
        const created = await createSchedule({ data: value });
        await queryClient.invalidateQueries({ queryKey: ["schedules"] });
        await navigate({ to: "/schedules/$scheduleId", params: { scheduleId: created.id } });
      } catch (error) {
        toast.error(message(error, "Could not create the schedule."));
      }
    },
  });
  return (
    <Page
      title="New schedule"
      backTo="/schedules"
      backLabel="Schedules"
      actions={
        <form.AppForm>
          <form.SubmitButton size="sm" form={formId}>
            Create schedule
          </form.SubmitButton>
        </form.AppForm>
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
    </Page>
  );
}
