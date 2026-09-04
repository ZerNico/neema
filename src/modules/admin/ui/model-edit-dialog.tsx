import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { listModelAccess, updateModel } from "../server/functions.ts";
import { groupsQuery } from "./groups-page.tsx";
import {
  ModelSettingsFields,
  modelSettingsFromDraft,
  type ModelSettingsDraft,
} from "./model-settings-form.tsx";
import type {
  ModelAccess,
  ModelCapabilities,
  ModelPricing,
  ModelType,
} from "~/modules/providers/model-config.ts";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { FieldError, FieldGroup } from "~/ui/primitives/field";
import { Spinner } from "~/ui/primitives/spinner";

export const modelAccessQuery = queryOptions({
  queryKey: ["admin", "model-access"],
  queryFn: () => listModelAccess(),
});

// The model settings form is tall; both model dialogs share one width and
// scroll inside the viewport instead of growing past it.
export const TALL_DIALOG_CLASS = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl";

export interface EditableModel {
  id: string;
  modelKey: string;
  displayName: string;
  type: ModelType;
  contextLength: number | null;
  embeddingDimensions: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  enabled: boolean;
  access: ModelAccess;
}

// Stays mounted; the caller drives `open` and keeps `model` set until the
// close animation has finished. Base UI unmounts the popup contents once
// closed, so the form (and its draft) starts fresh on every open.
export function ModelEditDialog({
  model,
  open,
  onOpenChange,
}: {
  model: EditableModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <Dialog
      open={open && model !== null}
      onOpenChange={(next) => {
        if (!next && saving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className={TALL_DIALOG_CLASS}>
        {model ? (
          <ModelEditForm
            key={model.id}
            model={model}
            onClose={() => onOpenChange(false)}
            onSavingChange={setSaving}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ModelEditForm({
  model,
  onClose,
  onSavingChange,
}: {
  model: EditableModel;
  onClose: () => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const { data: accessRows } = useSuspenseQuery(modelAccessQuery);
  const allowedIds = new Set(
    accessRows.filter((row) => row.modelId === model.id).map((row) => row.groupId),
  );
  const [draft, setDraft] = useState<ModelSettingsDraft>({
    displayName: model.displayName,
    type: model.type,
    contextLength: model.contextLength === null ? "" : String(model.contextLength),
    embeddingDimensions:
      model.embeddingDimensions === null ? "" : String(model.embeddingDimensions),
    capabilities: model.capabilities,
    inputPrice: model.pricing === null ? "" : String(model.pricing.input),
    outputPrice:
      model.pricing === null || model.pricing.output === null ? "" : String(model.pricing.output),
    enabled: model.enabled,
    access: model.access,
    selectedGroups: groups.filter((group) => allowedIds.has(group.id)),
  });
  const settings = modelSettingsFromDraft(draft);

  const save = useMutation({
    mutationFn: () => {
      if (settings === null) throw new Error("Invalid model settings");
      return updateModel({ data: { modelId: model.id, ...settings } });
    },
    onMutate: () => onSavingChange(true),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      ]);
      onClose();
    },
    onSettled: () => onSavingChange(false),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit model</DialogTitle>
        <DialogDescription>
          Configure how {model.displayName} appears, what it supports, and who can use it.
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (settings !== null) save.mutate();
        }}
      >
        <FieldGroup>
          <ModelSettingsFields
            draft={draft}
            setDraft={setDraft}
            groups={groups}
            modelKey={model.modelKey}
            autoFocusDisplayName
            disabled={save.isPending}
          />
        </FieldGroup>

        {save.isError ? <FieldError>Could not save the model.</FieldError> : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
            Cancel
          </DialogClose>
          <Button
            type="submit"
            disabled={settings === null || save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {save.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
            Save changes
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
