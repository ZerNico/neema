import { m } from "~/paraglide/messages.js";
import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { ModelPicker } from "~/modules/chat/ui/model-picker.tsx";
import { ListRow } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";

/** A saved configuration's chat model, where null means no preference. */
export function PreferredModelRow({
  value,
  onChange,
  errors,
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
  errors: NonNullable<ComponentProps<typeof FieldError>["errors"]>;
}) {
  const modelsQuery = useQuery(chatModelsQuery);
  const models = modelsQuery.data ?? [];
  const selected = models.find((model) => model.id === value) ?? null;
  const invalid = errors.length > 0 || undefined;
  return (
    // Wraps in the narrow rail: the label keeps its line and the picker takes
    // the rest, truncating long model names.
    <ListRow className="flex-wrap">
      <div className="flex min-w-24 shrink-0 flex-col">
        <span className="text-sm font-medium">Preferred model</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
        <ModelPicker
          models={models}
          value={value}
          onChange={(modelId) => onChange(modelId)}
          side="bottom"
          align="end"
          // oxlint-disable-next-line react/no-unstable-nested-components -- a render prop, not a component
          header={({ close }) => (
            <div className="p-1.5 pb-0">
              <button
                type="button"
                role="option"
                aria-selected={value === null}
                className="hover:bg-accent hover:text-accent-foreground flex w-full cursor-default items-center gap-2.5 rounded-2xl px-3 py-2 text-sm font-medium select-none"
                onClick={() => {
                  close();
                  onChange(null);
                }}
              >
                {m.chat_preferred_model_none()}
              </button>
            </div>
          )}
          trigger={
            <Button
              size="sm"
              variant="outline"
              className="w-full min-w-0 justify-between"
              aria-label={m.chat_preferred_model_label()}
              aria-invalid={invalid}
            />
          }
        >
          <span className="truncate">
            {selected?.displayName ??
              (value ? m.chat_preferred_model_unavailable() : m.chat_preferred_model_none())}
          </span>
        </ModelPicker>
        <FieldError errors={errors} />
      </div>
    </ListRow>
  );
}
