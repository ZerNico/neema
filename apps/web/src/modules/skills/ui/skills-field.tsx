import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState, type ComponentProps } from "react";
import { skillsQuery } from "~/modules/skills/client/queries.ts";
import { SkillPicker } from "~/modules/skills/ui/skill-picker.tsx";
import { ErrorState, ListCard, ListRow } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";

/** The skills a saved configuration installs, with any the reader can no longer use. */
export function SkillsField({
  value,
  onChange,
  errors,
  unavailableHint,
}: {
  value: readonly string[];
  onChange: (ids: string[]) => void;
  errors: NonNullable<ComponentProps<typeof FieldError>["errors"]>;
  /** What to do about a skill that is no longer available. */
  unavailableHint: string;
}) {
  const skills = useQuery(skillsQuery);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div className="space-y-3">
      {value.length > 0 ? (
        <ListCard>
          {value.map((id) => {
            const skill = skills.data?.find((candidate) => candidate.id === id);
            return (
              <ListRow key={id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {skill?.name ?? "Unavailable skill"}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {skill?.description ?? unavailableHint}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${skill?.name ?? "unavailable skill"}`}
                  onClick={() => onChange(value.filter((current) => current !== id))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </ListRow>
            );
          })}
        </ListCard>
      ) : null}
      {skills.isError ? (
        <ErrorState title="Could not load skills" onRetry={() => void skills.refetch()} />
      ) : (
        <Button
          ref={setAnchor}
          type="button"
          variant="outline"
          disabled={!skills.data}
          onClick={() => setPickerOpen(true)}
        >
          <HugeiconsIcon icon={PlusSignIcon} data-icon="inline-start" strokeWidth={2} />
          Add skills
        </Button>
      )}
      <SkillPicker
        items={skills.data ?? []}
        selectedIds={value}
        onChange={onChange}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        anchor={anchor}
        limit={20}
      />
      <FieldError errors={errors} />
    </div>
  );
}
