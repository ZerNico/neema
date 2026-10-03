import { ArrowRight01Icon, CloudServerIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { createProvider, listModels, listProviders } from "../server/functions.ts";
import { DefaultModelsDialog } from "./default-model-order.tsx";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { getPreset, type PresetId, type ProviderSettings } from "@chat/model-client/presets";
import { readServerError } from "~/server-error.ts";
import { PresetSelect, ProviderSettingsFields } from "./provider-settings-fields.tsx";
import { Badge } from "~/ui/primitives/badge";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { OptionalMark } from "~/ui/form/app-form.tsx";

export const providersQuery = queryOptions({
  queryKey: ["admin", "providers"],
  queryFn: () => listProviders(),
});

export const modelsQuery = queryOptions({
  queryKey: ["admin", "models"],
  queryFn: () => listModels(),
});

const EMPTY_DRAFT: {
  name: string;
  preset: PresetId;
  baseUrl: string;
  apiKey: string;
  settings: ProviderSettings;
} = {
  name: "OpenRouter",
  preset: "openrouter",
  baseUrl: "",
  apiKey: "",
  settings: {},
};

export function ProvidersPage() {
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [adding, setAdding] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);

  return (
    <Page
      title="Providers"
      description="AI providers this instance can talk to."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setEditingDefaults(true)}>
            Default models
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            Add provider
          </Button>
        </>
      }
    >
      {providers.length === 0 ? (
        <EmptyState
          icon={CloudServerIcon}
          title="No providers yet"
          description="Connect a provider like OpenRouter to make models available for chat."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              Add provider
            </Button>
          }
        />
      ) : (
        <ListCard>
          {providers.map((provider) => {
            const modelCount = models.filter((m) => m.providerId === provider.id).length;
            return (
              <Link
                key={provider.id}
                to="/admin/providers/$providerId"
                params={{ providerId: provider.id }}
                className="block"
              >
                <ListRow interactive>
                  <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                    <HugeiconsIcon icon={CloudServerIcon} strokeWidth={2} className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {provider.name}
                      {!provider.enabled ? <Badge variant="outline">Disabled</Badge> : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {getPreset(provider.preset).label} ·{" "}
                      {modelCount === 1 ? "1 model" : `${modelCount} models`}
                    </span>
                  </div>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </ListRow>
              </Link>
            );
          })}
        </ListCard>
      )}
      <DefaultModelsDialog
        open={editingDefaults}
        onOpenChange={setEditingDefaults}
        models={models}
        providers={providers}
      />
      <AddProviderDialog open={adding} onOpenChange={setAdding} />
    </Page>
  );
}

function AddProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const preset = getPreset(draft.preset);
  // A preset without a shared endpoint (Azure, self-hosted) needs its own.
  const needsBaseUrl = preset.baseUrl === null;
  const complete = Boolean(
    draft.name.trim() &&
    (!preset.keyRequired || draft.apiKey.trim()) &&
    (!needsBaseUrl || draft.baseUrl.trim()),
  );
  const reset = () => setDraft(EMPTY_DRAFT);

  const add = useMutation({
    mutationFn: () =>
      createProvider({
        data: {
          preset: draft.preset,
          name: draft.name.trim(),
          ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
          // Blank uses the preset's endpoint, which the placeholder shows.
          ...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
          settings: draft.settings,
        },
      }),
    onSuccess: async (provider) => {
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      reset();
      onOpenChange(false);
      // Jump straight into the detail page so models can be added immediately.
      await navigate({
        to: "/admin/providers/$providerId",
        params: { providerId: provider.id },
      });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (add.isPending) return;
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            The API key is encrypted at rest and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) add.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-preset`}>Service</FieldLabel>
              <PresetSelect
                id={`${id}-preset`}
                value={draft.preset}
                onChange={(next) =>
                  setDraft((d) => ({
                    ...d,
                    preset: next,
                    // Settings belong to the preset they were chosen for.
                    settings: {},
                    name:
                      d.name === "" || d.name === getPreset(d.preset).label
                        ? getPreset(next).label
                        : d.name,
                  }))
                }
                disabled={add.isPending}
              />
              {preset.note ? <FieldDescription>{preset.note}</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="OpenRouter"
                disabled={add.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-base-url`}>
                Base URL {needsBaseUrl ? null : <OptionalMark />}
              </FieldLabel>
              <Input
                id={`${id}-base-url`}
                value={draft.baseUrl}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder={preset.baseUrl ?? preset.baseUrlPlaceholder ?? ""}
                disabled={add.isPending}
              />
            </Field>
            <ProviderSettingsFields
              id={id}
              preset={preset}
              settings={draft.settings}
              onChange={(settings) => setDraft((d) => ({ ...d, settings }))}
              disabled={add.isPending}
            />
            <Field>
              <FieldLabel htmlFor={`${id}-api-key`}>
                API key {preset.keyRequired ? null : <OptionalMark />}
              </FieldLabel>
              <Input
                id={`${id}-api-key`}
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                disabled={add.isPending}
              />
            </Field>
          </FieldGroup>
          {add.isError ? (
            <FieldError>
              {readServerError(add.error).reason ?? "Could not add the provider."}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={add.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={add.isPending} disabled={!complete}>
              Add provider
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
