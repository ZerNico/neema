import { ArrowRight01Icon, CloudServerIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { createProvider } from "../server/functions.ts";
import { ModelOrderDialog } from "./model-order.tsx";
import { ReviewModelPicker, UtilityModelPicker } from "./utility-model-picker.tsx";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { getPreset, type PresetId, type ProviderSettings } from "@chat/model-client/presets";
import { readServerError } from "~/server-error.ts";
import { ProviderCredentialFields } from "./provider-credential-fields.tsx";
import {
  credentialsInput,
  credentialsReady,
  EMPTY_CREDENTIALS,
  type CredentialDraft,
} from "./provider-credentials.ts";
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
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { providersQuery, modelsQuery } from "../client/queries.ts";
import { m } from "~/paraglide/messages.js";
import { baseUrlLabel, presetLabel, presetNote } from "../preset-words.ts";

const EMPTY_DRAFT: {
  name: string;
  preset: PresetId;
  baseUrl: string;
  credentials: CredentialDraft;
  settings: ProviderSettings;
} = {
  name: "OpenRouter",
  preset: "openrouter",
  baseUrl: "",
  credentials: EMPTY_CREDENTIALS,
  settings: {},
};

export function ProvidersPage() {
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [adding, setAdding] = useState(false);
  const [editingOrder, setEditingOrder] = useState(false);

  return (
    <Page
      title={m.admin_providers_title()}
      description={m.admin_providers_description()}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setEditingOrder(true)}>
            {m.admin_providers_model_order()}
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            {m.admin_providers_add()}
          </Button>
        </>
      }
    >
      {providers.length === 0 ? (
        <EmptyState
          icon={CloudServerIcon}
          title={m.admin_providers_empty_title()}
          description={m.admin_providers_empty_description()}
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              {m.admin_providers_add()}
            </Button>
          }
        />
      ) : (
        <ListCard>
          {providers.map((provider) => {
            const modelCount = models.filter((model) => model.providerId === provider.id).length;
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
                      {!provider.enabled ? (
                        <Badge variant="outline">{m.admin_providers_disabled()}</Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {presetLabel(getPreset(provider.preset))} ·{" "}
                      {m.admin_providers_model_count({ count: modelCount })}
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
      {models.some((model) => model.type === "chat") ? (
        <>
          <UtilityModelPicker models={models} providers={providers} />
          <ReviewModelPicker models={models} providers={providers} />
        </>
      ) : null}
      <ModelOrderDialog
        open={editingOrder}
        onOpenChange={setEditingOrder}
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
    credentialsReady(preset, draft.settings, draft.credentials) &&
    (!needsBaseUrl || draft.baseUrl.trim()),
  );
  const reset = () => setDraft(EMPTY_DRAFT);

  const add = useMutation({
    mutationFn: () =>
      createProvider({
        data: {
          preset: draft.preset,
          name: draft.name.trim(),
          ...credentialsInput(preset, draft.settings, draft.credentials),
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
          <DialogTitle>{m.admin_providers_add()}</DialogTitle>
          <DialogDescription>{m.admin_providers_add_description()}</DialogDescription>
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
              <FieldLabel htmlFor={`${id}-preset`}>{m.admin_providers_service()}</FieldLabel>
              <PresetSelect
                id={`${id}-preset`}
                value={draft.preset}
                onChange={(next) =>
                  setDraft((d) => ({
                    ...d,
                    preset: next,
                    // Settings belong to the preset they were chosen for.
                    settings: {},
                    credentials: EMPTY_CREDENTIALS,
                    name:
                      d.name === "" || d.name === presetLabel(getPreset(d.preset))
                        ? presetLabel(getPreset(next))
                        : d.name,
                  }))
                }
                disabled={add.isPending}
              />
              {presetNote(preset) ? (
                <FieldDescription>{presetNote(preset)}</FieldDescription>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{m.admin_providers_name()}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                // oxlint-disable-next-line i18n/no-literal-text -- a product name as the example
                placeholder="OpenRouter"
                disabled={add.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-base-url`}>
                {baseUrlLabel(preset)} {needsBaseUrl ? null : <OptionalMark />}
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
            <ProviderCredentialFields
              id={id}
              preset={preset}
              settings={draft.settings}
              onSettingsChange={(settings) => setDraft((d) => ({ ...d, settings }))}
              draft={draft.credentials}
              onChange={(credentials) => setDraft((d) => ({ ...d, credentials }))}
              disabled={add.isPending}
            />
          </FieldGroup>
          {add.isError ? (
            <FieldError>
              {readServerError(add.error).reason ?? m.admin_providers_error_add()}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={add.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={add.isPending} disabled={!complete}>
              {m.admin_providers_add()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
