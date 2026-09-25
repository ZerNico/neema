import { queryOptions, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Schema } from "effect";
import { NumberField, integerBetween } from "~/modules/tools/ui/tool-fields.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { useAppForm } from "~/ui/form/app-form.tsx";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { SaveLabel, SaveStatus, useSaveStatus } from "~/ui/save-status.tsx";
import { getProjectFileSettings, updateProjectFileSettings } from "../server/functions.ts";

const MB = 1024 * 1024;
/** The same bounds the server takes in bytes, in the unit people think in. */
const CapMegabytes = integerBetween(10, 1024 * 1024);
const CapForm = Schema.toStandardSchemaV1(Schema.Struct({ megabytes: CapMegabytes }));

export const projectFileSettingsQuery = queryOptions({
  queryKey: ["admin", "project-files"],
  queryFn: () => getProjectFileSettings(),
});

/** How much each project may keep in files, history included. */
export function ProjectFileSettingsSection() {
  const { data } = useSuspenseQuery(projectFileSettingsQuery);
  const queryClient = useQueryClient();
  const { justSaved, markSaved } = useSaveStatus();
  const form = useAppForm({
    defaultValues: { megabytes: String(Math.round(data.maxProjectBytes / MB)) },
    validators: { onSubmit: CapForm },
    onSubmit: async ({ value }) => {
      try {
        await updateProjectFileSettings({
          data: { maxProjectBytes: Number(value.megabytes) * MB },
        });
      } catch (error) {
        toastError("Could not save the storage limit.", error);
        return;
      }
      markSaved();
      form.reset(value);
      await queryClient.invalidateQueries({ queryKey: projectFileSettingsQuery.queryKey });
    },
  });
  return (
    <Section title="Project files">
      <ListCard>
        <ListRow className="flex-col items-stretch gap-3">
          <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <form.Field
              name="megabytes"
              validators={{ onSubmit: Schema.toStandardSchemaV1(CapMegabytes) }}
            >
              {(field) => (
                <NumberField
                  field={field}
                  label="Storage per project (MB)"
                  description="Every version counts. Near the limit the oldest unpinned versions go first; a save that still doesn’t fit is refused."
                  min={10}
                  max={1024 * 1024}
                  step={10}
                />
              )}
            </form.Field>
            <div className="flex gap-2">
              <form.AppForm>
                <form.SubmitButton size="sm">
                  <SaveLabel justSaved={justSaved}>Save</SaveLabel>
                </form.SubmitButton>
              </form.AppForm>
              <SaveStatus justSaved={justSaved} />
            </div>
          </form>
        </ListRow>
      </ListCard>
    </Section>
  );
}
