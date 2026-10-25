import {
  AiBrain01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import {
  probeEmbeddingDimensions,
  createModel,
  deleteModel,
  deleteProvider,
  updateProvider,
} from "../server/functions.ts";
import { groupsQuery, modelsQuery, providersQuery } from "../client/queries.ts";
import { type CatalogPick, ModelCombobox } from "./model-combobox.tsx";
import { ModelEditDialog } from "./model-edit-dialog.tsx";
import { MODEL_DIALOG_CLASS } from "./model-dialog.ts";
import { ModelTestResult } from "./model-test.tsx";
import { useModelTest } from "./use-model-test.ts";
import { ModelSettingsFields } from "./model-settings-form.tsx";
import { ImageModelTestResult } from "./image-model-test.tsx";
import { useImageModelTest } from "./use-image-model-test.ts";
import {
  imageFamiliesFor,
  inferImageFamily,
  suggestedImageCapabilities,
} from "@chat/model-client/image-families";
import { MODEL_TYPE_LABELS } from "./model-settings-labels.ts";
import {
  emptyModelSettingsDraft,
  imagePricesFromCatalog,
  type ModelSettingsDraft,
  modelSettingsFromDraft,
} from "./model-settings-draft.ts";
import { CapabilityIcons, ContextBadge } from "~/modules/providers/ui/capability-icons.tsx";
import {
  baseUrlField,
  getPreset,
  effectiveSettings,
  type PresetId,
  type ProviderSettings,
  type SettingKey,
} from "@chat/model-client/presets";
import { readServerError } from "~/server-error.ts";
import { ProviderCredentialFields } from "./provider-credential-fields.tsx";
import { credentialsInput, credentialsReady, EMPTY_CREDENTIALS } from "./provider-credentials.ts";
import { ProviderSettingsFields } from "./provider-settings-fields.tsx";
import { AUTH_LABELS, FORMAT_LABELS, REASONING_LABELS } from "./provider-settings-labels.ts";

import { useConfirm } from "~/ui/confirm-context.ts";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { toastError } from "~/ui/error-toast.ts";
import { OptionalMark } from "~/ui/form/form-fields.tsx";
import { m } from "~/paraglide/messages.js";
import { baseUrlLabel, presetLabel } from "../preset-words.ts";

export function ProviderDetailPage({ providerId }: { providerId: string }) {
  const id = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: allModels } = useSuspenseQuery(modelsQuery);
  const [addingModel, setAddingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editingModelOpen, setEditingModelOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();

  const provider = providers.find((p) => p.id === providerId);
  const models = allModels.filter((model) => model.providerId === providerId);
  const editingModel = models.find((model) => model.id === editingModelId) ?? null;

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      queryClient.invalidateQueries({ queryKey: ["image-models"] }),
    ]);

  const toggleProvider = useMutation({
    mutationFn: (enabled: boolean) => updateProvider({ data: { providerId, enabled } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.admin_provider_error_update(), error),
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider({ data: { providerId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/admin/providers" });
    },
    onError: (error) => toastError(m.admin_provider_error_delete(), error),
  });

  const removeModel = useMutation({
    mutationFn: (modelId: string) => deleteModel({ data: { modelId } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.admin_provider_error_delete_model(), error),
  });

  if (!provider) {
    return (
      <Page
        title={m.admin_provider_not_found()}
        backTo="/admin/providers"
        backLabel={m.admin_provider_back()}
      >
        <p className="text-muted-foreground text-sm">{m.admin_provider_gone()}</p>
      </Page>
    );
  }
  const preset = getPreset(provider.preset);
  const settings = effectiveSettings(preset, provider.settings);
  const can = (key: SettingKey) => preset.overridable.includes(key);

  return (
    <Page
      title={provider.name}
      backTo="/admin/providers"
      backLabel={m.admin_provider_back()}
      actions={
        <>
          {/* oxlint-disable-next-line shadcn/no-restyle -- an inline toggle in the page header, not a stacked form row */}
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel htmlFor={`${id}-enabled`} className="text-muted-foreground max-sm:sr-only">
              {m.admin_provider_enabled()}
            </FieldLabel>
            <Switch
              id={`${id}-enabled`}
              checked={provider.enabled}
              disabled={toggleProvider.isPending}
              onCheckedChange={(checked) => toggleProvider.mutate(checked)}
            />
          </Field>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" aria-label={m.admin_provider_actions()} />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                {m.admin_provider_edit()}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  if (
                    await confirm({
                      title: m.admin_provider_delete_title({ name: provider.name }),
                      description: m.admin_provider_delete_description(),
                      confirmLabel: m.admin_provider_delete(),
                    })
                  ) {
                    removeProvider.mutate();
                  }
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {m.admin_provider_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <Section title={m.admin_provider_connection()}>
        <ListCard>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">
              {m.admin_provider_service()}
            </span>
            <span className="text-sm">{presetLabel(preset)}</span>
          </ListRow>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">
              {baseUrlLabel(preset)}
            </span>
            <span className="min-w-0 truncate font-mono text-sm">
              {baseUrlField(preset, provider.baseUrl).value}
            </span>
          </ListRow>
          {/* Only what the admin chose: fixed values would read as settings. */}
          {can("format") && preset.formats.length > 1 ? (
            <ListRow>
              <span className="text-muted-foreground w-24 shrink-0 text-sm">
                {m.admin_provider_api()}
              </span>
              <span className="text-sm">{FORMAT_LABELS[settings.format]}</span>
            </ListRow>
          ) : null}
          {/* Responses always takes a level; on Chat Completions the provider names its field. */}
          {can("reasoning") && settings.format === "chat-completions" ? (
            <ListRow>
              <span className="text-muted-foreground w-24 shrink-0 text-sm">
                {m.admin_provider_reasoning_level()}
              </span>
              <span className="text-sm">{REASONING_LABELS[settings.reasoning]}</span>
            </ListRow>
          ) : null}
          {can("auth") ? (
            <ListRow>
              <span className="text-muted-foreground w-24 shrink-0 text-sm">
                {m.admin_provider_sign_in_with()}
              </span>
              <span className="text-sm">{AUTH_LABELS[settings.auth]}</span>
            </ListRow>
          ) : null}
        </ListCard>
      </Section>

      <Section
        title={m.admin_provider_models()}
        actions={
          <Button size="sm" onClick={() => setAddingModel(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            {m.admin_provider_add_model()}
          </Button>
        }
      >
        {models.length === 0 ? (
          <EmptyState
            icon={AiBrain01Icon}
            title={m.admin_provider_empty_title()}
            description={m.admin_provider_empty_description()}
            action={
              <Button size="sm" onClick={() => setAddingModel(true)}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                {m.admin_provider_add_model()}
              </Button>
            }
          />
        ) : (
          <ListCard>
            {models.map((model) => (
              <ListRow key={model.id}>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="min-w-0 truncate">{model.displayName}</span>
                    <Badge variant="secondary">{MODEL_TYPE_LABELS[model.type]}</Badge>
                  </span>
                  <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                    <span className="min-w-0 truncate">{model.modelKey}</span>
                    <ContextBadge contextLength={model.contextLength} />
                    <CapabilityIcons capabilities={model.capabilities} />
                  </span>
                </div>
                <Badge variant="outline">
                  {model.access === "public"
                    ? m.admin_provider_public()
                    : m.admin_provider_private()}
                </Badge>
                {!model.enabled ? (
                  <Badge variant="outline">{m.admin_provider_disabled()}</Badge>
                ) : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.admin_provider_edit_model({ name: model.displayName })}
                  onClick={() => {
                    setEditingModelId(model.id);
                    setEditingModelOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.admin_provider_delete_model_label({ name: model.displayName })}
                  disabled={removeModel.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: m.admin_provider_delete_model_title({ name: model.displayName }),
                        description: m.admin_provider_delete_model_description(),
                        confirmLabel: m.admin_provider_delete_model(),
                      })
                    ) {
                      removeModel.mutate(model.id);
                    }
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        )}
      </Section>

      <AddModelDialog
        providerId={providerId}
        presetId={provider.preset}
        open={addingModel}
        onOpenChange={setAddingModel}
      />

      <ModelEditDialog
        model={editingModel}
        presetId={provider.preset}
        open={editingModelOpen}
        onOpenChange={setEditingModelOpen}
      />

      <EditProviderDialog provider={provider} open={editing} onOpenChange={setEditing} />
    </Page>
  );
}

export function AddModelDialog({
  providerId,
  presetId,
  open,
  onOpenChange,
}: {
  providerId: string;
  /** Azure names deployments, which no catalog lists, so its field asks for one. */
  presetId?: PresetId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const selectedId = useRef<string | null>(null);
  const [pick, setPick] = useState<CatalogPick | null>(null);
  const [typed, setTyped] = useState("");
  // Where each model has its own API, a new one starts on the preset's.
  const initialDraft = (): ModelSettingsDraft => ({
    ...emptyModelSettingsDraft(),
    format: presetId && getPreset(presetId).modelFormat ? "responses" : null,
  });
  const [draft, setDraft] = useState(initialDraft);

  // Only an explicit selection opens the settings: a catalog row, or the
  // creatable "Add … as custom model" row for ids the catalog does not know.
  // Half-typed search text is not a model yet, and showing chat toggles for it
  // suggests a choice that has not been made.
  const effective: CatalogPick | null = pick && (typed === "" || typed === pick.id) ? pick : null;
  const settings = modelSettingsFromDraft(draft);
  const test = useModelTest(providerId, (format) =>
    setDraft((current) => ({ ...current, format })),
  );
  const imageTest = useImageModelTest(providerId);

  const reset = () => {
    selectedId.current = null;
    setPick(null);
    setTyped("");
    setDraft(initialDraft());
    test.clear();
    imageTest.clear();
  };

  const add = useMutation({
    mutationFn: () => {
      if (effective === null || settings === null) throw new Error("Invalid model settings");
      return createModel({
        data: {
          providerId,
          modelKey: effective.id,
          ...settings,
        },
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
        queryClient.invalidateQueries({ queryKey: ["image-models"] }),
      ]);
      reset();
      onOpenChange(false);
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
      <DialogContent className={MODEL_DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>{m.admin_provider_add_model()}</DialogTitle>
          <DialogDescription>
            {presetId === "azure" ? m.admin_add_model_azure() : m.admin_add_model_catalog()}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (effective !== null && settings !== null) add.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-model`}>
                {presetId === "azure" ? m.admin_add_model_deployment() : m.admin_add_model_model()}
              </FieldLabel>
              <ModelCombobox
                inputId={`${id}-model`}
                providerId={providerId}
                disabled={add.isPending}
                // An example deployment name, not words.
                {...(presetId === "azure" ? { placeholder: "my-gpt-deployment" } : {})}
                onPick={(picked) => {
                  selectedId.current = picked.id;
                  setPick(picked);
                  setTyped(picked.id);
                  // A typed id the client knows (gpt-image-1, dall-e-3) starts as that image model.
                  const typedFamily =
                    picked.custom && presetId ? inferImageFamily(presetId, picked.id) : null;
                  const family = picked.imageFamily ?? typedFamily;
                  setDraft((current) => ({
                    ...current,
                    displayName: picked.name,
                    type: typedFamily ? "image" : picked.type,
                    imageFamily: family,
                    imageCapabilities: family
                      ? suggestedImageCapabilities(family, picked.id)
                      : null,
                    contextLength:
                      picked.contextLength === null ? "" : String(picked.contextLength),
                    embeddingDimensions: "",
                    capabilities: picked.capabilities ?? current.capabilities,
                    inputPrice:
                      picked.pricing === null || picked.pricing === undefined
                        ? ""
                        : String(picked.pricing.input),
                    outputPrice:
                      picked.pricing?.output === null || picked.pricing?.output === undefined
                        ? ""
                        : String(picked.pricing.output),
                    cacheReadPrice:
                      picked.pricing?.cacheRead === undefined
                        ? ""
                        : String(picked.pricing.cacheRead),
                    cacheWritePrice:
                      picked.pricing?.cacheWrite === undefined
                        ? ""
                        : String(picked.pricing.cacheWrite),
                    imagePrices: imagePricesFromCatalog(picked.imagePricing),
                  }));
                }}
                onInput={(value) => {
                  setTyped(value);
                  if (value === selectedId.current) return;
                  selectedId.current = null;
                  setPick(null);
                  setDraft({ ...initialDraft(), displayName: value.trim() });
                }}
              />
              {effective ? (
                <FieldDescription>
                  {effective.custom ? m.admin_add_model_custom() : m.admin_add_model_defaults()}
                </FieldDescription>
              ) : null}
            </Field>

            {effective ? (
              <ModelSettingsFields
                draft={draft}
                setDraft={setDraft}
                groups={groups}
                imageFamilies={presetId ? imageFamiliesFor(presetId) : []}
                disabled={add.isPending}
                onDetectDimensions={() =>
                  probeEmbeddingDimensions({ data: { providerId, modelKey: effective.id } })
                }
              />
            ) : null}
          </FieldGroup>

          <ModelTestResult test={test.resultFor(effective?.id)} />
          <ImageModelTestResult result={imageTest.resultFor(effective?.id, draft.imageFamily)} />
          {add.isError ? <FieldError>{m.admin_add_model_error()}</FieldError> : null}
          <DialogFooter>
            {effective && draft.type === "image" && draft.imageFamily ? (
              <PendingButton
                variant="outline"
                pending={imageTest.pending}
                disabled={add.isPending}
                onClick={() => imageTest.run(effective.id, draft.imageFamily!)}
              >
                {m.admin_model_test_image()}
              </PendingButton>
            ) : null}
            {effective && draft.type === "chat" ? (
              <PendingButton
                variant="outline"
                pending={test.pending}
                disabled={add.isPending}
                onClick={() => test.run(effective.id, draft.format)}
              >
                {m.admin_model_test()}
              </PendingButton>
            ) : null}
            <DialogClose render={<Button variant="outline" disabled={add.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton
              type="submit"
              pending={add.isPending}
              disabled={effective === null || settings === null}
            >
              {m.admin_provider_add_model()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: {
    id: string;
    name: string;
    preset: PresetId;
    baseUrl: string;
    settings: ProviderSettings;
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const preset = getPreset(provider.preset);
  // The default shows as the placeholder, so a provider on it opens with an empty field.
  const initialBaseUrl =
    provider.baseUrl === preset.baseUrl ? "" : baseUrlField(preset, provider.baseUrl).value;
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [settings, setSettings] = useState(provider.settings);
  // Empty means "keep the current key", since the stored key can't be shown.
  const [credentials, setCredentials] = useState(EMPTY_CREDENTIALS);
  const stored = effectiveSettings(preset, provider.settings).auth;
  const needsBaseUrl = preset.baseUrl === null;
  const complete = Boolean(
    name.trim() &&
    (!needsBaseUrl || baseUrl.trim()) &&
    credentialsReady(preset, settings, credentials, stored),
  );

  const save = useMutation({
    mutationFn: () =>
      updateProvider({
        data: {
          providerId: provider.id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          settings,
          ...credentialsInput(preset, settings, credentials),
        },
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        // Base URL or key changes invalidate the cached model catalog too.
        queryClient.invalidateQueries({ queryKey: ["provider-catalog", provider.id] }),
      ]);
      setName(name.trim());
      setBaseUrl(baseUrl.trim());
      setCredentials(EMPTY_CREDENTIALS);
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (save.isPending) return;
          setName(provider.name);
          setBaseUrl(initialBaseUrl);
          setSettings(provider.settings);
          setCredentials(EMPTY_CREDENTIALS);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.admin_provider_edit()}</DialogTitle>
          <DialogDescription>{m.admin_edit_provider_description()}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (complete) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>{m.admin_edit_provider_name()}</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={save.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-base-url`}>
                {baseUrlLabel(preset)} {needsBaseUrl ? null : <OptionalMark />}
              </FieldLabel>
              <Input
                id={`${id}-base-url`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={preset.baseUrl ?? preset.baseUrlPlaceholder ?? ""}
                disabled={save.isPending}
              />
            </Field>
            <ProviderSettingsFields
              id={id}
              preset={preset}
              settings={settings}
              onChange={setSettings}
              disabled={save.isPending}
            />
            <ProviderCredentialFields
              id={id}
              preset={preset}
              settings={settings}
              onSettingsChange={setSettings}
              draft={credentials}
              onChange={setCredentials}
              stored={stored}
              disabled={save.isPending}
            />
          </FieldGroup>
          {save.isError ? (
            <FieldError>
              {readServerError(save.error).reason ?? m.admin_edit_provider_error()}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              {m.common_cancel()}
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!complete}>
              {m.common_save_changes()}
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
