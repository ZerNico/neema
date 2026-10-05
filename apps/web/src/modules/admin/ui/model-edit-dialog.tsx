import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { probeEmbeddingDimensions, updateModel } from "../server/functions.ts";
import { groupsQuery, modelAccessQuery } from "../client/queries.ts";
import { ModelSettingsFields } from "./model-settings-form.tsx";
import { modelSettingsFromDraft, type ModelSettingsDraft } from "./model-settings-draft.ts";
import { ModelTestResult } from "./model-test.tsx";
import { useModelTest } from "./use-model-test.ts";
import { getPreset, type PresetId } from "@chat/model-client/presets";
import type {
  ModelAccess,
  ModelCapabilities,
  ModelFormat,
  ModelPricing,
  ModelType,
} from "~/modules/providers/model-config.ts";
import { PendingButton } from "~/ui/pending-button.tsx";
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
import { MODEL_DIALOG_CLASS } from "./model-dialog.ts";

export interface EditableModel {
  id: string;
  providerId: string;
  modelKey: string;
  format?: ModelFormat | null;
  displayName: string;
  description?: string | null;
  type: ModelType;
  contextLength: number | null;
  embeddingDimensions: number | null;
  capabilities: ModelCapabilities;
  pricing: ModelPricing | null;
  enabled: boolean;
  access: ModelAccess;
}

/**
 * Stays mounted; the caller drives `open` and keeps `model` set until the
 * close animation has finished. Base UI unmounts the popup contents once
 * closed, so the form (and its draft) starts fresh on every open.
 */
export function ModelEditDialog({
  model,
  presetId,
  open,
  onOpenChange,
}: {
  model: EditableModel | null;
  /** Where the preset gives each model its own API, the form offers it. */
  presetId?: PresetId | undefined;
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
      <DialogContent className={MODEL_DIALOG_CLASS}>
        {model ? (
          <ModelEditForm
            key={model.id}
            model={model}
            apiChoice={presetId !== undefined && getPreset(presetId).modelFormat === true}
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
  apiChoice,
  onClose,
  onSavingChange,
}: {
  model: EditableModel;
  apiChoice: boolean;
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
    description: model.description ?? "",
    type: model.type,
    contextLength: model.contextLength === null ? "" : String(model.contextLength),
    embeddingDimensions:
      model.embeddingDimensions === null ? "" : String(model.embeddingDimensions),
    capabilities: model.capabilities,
    inputPrice: model.pricing === null ? "" : String(model.pricing.input),
    outputPrice:
      model.pricing === null || model.pricing.output === null ? "" : String(model.pricing.output),
    cacheReadPrice: model.pricing?.cacheRead === undefined ? "" : String(model.pricing.cacheRead),
    cacheWritePrice:
      model.pricing?.cacheWrite === undefined ? "" : String(model.pricing.cacheWrite),
    enabled: model.enabled,
    access: model.access,
    selectedGroups: groups.filter((group) => allowedIds.has(group.id)),
    format: apiChoice ? (model.format ?? "responses") : null,
  });
  const settings = modelSettingsFromDraft(draft);
  const test = useModelTest(model.providerId, (format) =>
    setDraft((current) => ({ ...current, format })),
  );

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
            onDetectDimensions={() =>
              probeEmbeddingDimensions({
                data: { providerId: model.providerId, modelKey: model.modelKey },
              })
            }
          />
        </FieldGroup>

        <ModelTestResult test={test.resultFor(model.modelKey)} />
        {save.isError ? <FieldError>Could not save the model.</FieldError> : null}
        <DialogFooter>
          {draft.type === "chat" ? (
            <PendingButton
              variant="outline"
              pending={test.pending}
              disabled={save.isPending}
              onClick={() => test.run(model.modelKey, draft.format)}
            >
              Test
            </PendingButton>
          ) : null}
          <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
            Cancel
          </DialogClose>
          <PendingButton type="submit" pending={save.isPending} disabled={settings === null}>
            Save changes
          </PendingButton>
        </DialogFooter>
      </form>
    </>
  );
}
