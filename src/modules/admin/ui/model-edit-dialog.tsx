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
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";

export const modelAccessQuery = queryOptions({
  queryKey: ["admin", "model-access"],
  queryFn: () => listModelAccess(),
});

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

export function ModelEditDialog({ model, onClose }: { model: EditableModel; onClose: () => void }) {
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
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      ]);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
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
          <ModelSettingsFields
            draft={draft}
            setDraft={setDraft}
            groups={groups}
            modelKey={model.modelKey}
            autoFocusDisplayName
          />

          {save.isError ? (
            <p className="text-destructive text-sm">Could not save the model settings.</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={settings === null || save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
