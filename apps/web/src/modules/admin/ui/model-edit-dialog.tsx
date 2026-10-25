import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { probeEmbeddingDimensions, updateModel } from "../server/functions.ts";
import { groupsQuery, modelAccessQuery } from "../client/queries.ts";
import { ModelSettingsFields } from "./model-settings-form.tsx";
import {
  imagePricesOf,
  modelSettingsFromDraft,
  type ModelSettingsDraft,
} from "./model-settings-draft.ts";
import { ImageModelTestResult } from "./image-model-test.tsx";
import { useImageModelTest } from "./use-image-model-test.ts";
import {
  imageFamiliesFor,
  type ImageCapabilities,
  type ImageFamily,
  type ImageFamilyInfo,
} from "@chat/model-client/image-families";
import { ModelTestResult } from "./model-test.tsx";
import { useModelTest } from "./use-model-test.ts";
import { getPreset, type PresetId } from "@chat/model-client/presets";
import type {
  ModelAccess,
  ModelCapabilities,
  ModelFormat,
  ImagePricing,
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
import { m } from "~/paraglide/messages.js";

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
  imageFamily?: ImageFamily | null;
  imageCapabilities?: ImageCapabilities | null;
  imagePricing?: ImagePricing | null;
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
            imageFamilies={presetId ? imageFamiliesFor(presetId) : []}
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
  imageFamilies,
  onClose,
  onSavingChange,
}: {
  model: EditableModel;
  apiChoice: boolean;
  imageFamilies: ReadonlyArray<ImageFamilyInfo>;
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
    imageFamily: model.imageFamily ?? null,
    imageCapabilities: model.imageCapabilities ?? null,
    imagePrices: imagePricesOf(model.imagePricing ?? null),
  });
  const settings = modelSettingsFromDraft(draft);
  const test = useModelTest(model.providerId, (format) =>
    setDraft((current) => ({ ...current, format })),
  );
  const imageTest = useImageModelTest(model.providerId);

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
        queryClient.invalidateQueries({ queryKey: ["image-models"] }),
      ]);
      onClose();
    },
    onSettled: () => onSavingChange(false),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{m.admin_edit_model_title()}</DialogTitle>
        <DialogDescription>
          {m.admin_edit_model_description({ name: model.displayName })}
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
            imageFamilies={imageFamilies}
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
        <ImageModelTestResult result={imageTest.resultFor(model.modelKey, draft.imageFamily)} />
        {save.isError ? <FieldError>{m.admin_edit_model_error_save()}</FieldError> : null}
        <DialogFooter>
          {draft.type === "image" && draft.imageFamily ? (
            <PendingButton
              variant="outline"
              pending={imageTest.pending}
              disabled={save.isPending}
              onClick={() => imageTest.run(model.modelKey, draft.imageFamily!)}
            >
              {m.admin_model_test_image()}
            </PendingButton>
          ) : null}
          {draft.type === "chat" ? (
            <PendingButton
              variant="outline"
              pending={test.pending}
              disabled={save.isPending}
              onClick={() => test.run(model.modelKey, draft.format)}
            >
              {m.admin_model_test()}
            </PendingButton>
          ) : null}
          <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
            {m.common_cancel()}
          </DialogClose>
          <PendingButton type="submit" pending={save.isPending} disabled={settings === null}>
            {m.common_save_changes()}
          </PendingButton>
        </DialogFooter>
      </form>
    </>
  );
}
