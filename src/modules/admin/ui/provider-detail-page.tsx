import {
  AiBrain01Icon,
  Delete02Icon,
  MoreVerticalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { createModel, deleteModel, deleteProvider, updateProvider } from "../server/functions.ts";
import { groupsQuery } from "./groups-page.tsx";
import { type CatalogPick, ModelCombobox } from "./model-combobox.tsx";
import { ModelEditDialog, TALL_DIALOG_CLASS } from "./model-edit-dialog.tsx";
import {
  emptyModelSettingsDraft,
  MODEL_TYPE_LABELS,
  ModelSettingsFields,
  modelSettingsFromDraft,
} from "./model-settings-form.tsx";
import { CapabilityIcons, ContextBadge } from "~/modules/providers/ui/capability-icons.tsx";
import { modelsQuery, PROVIDER_PRESETS, providersQuery } from "./providers-page.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { EmptyState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
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
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";

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
  const models = allModels.filter((m) => m.providerId === providerId);
  const editingModel = models.find((model) => model.id === editingModelId) ?? null;

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
    ]);

  const toggleProvider = useMutation({
    mutationFn: (enabled: boolean) => updateProvider({ data: { providerId, enabled } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not update the provider."),
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider({ data: { providerId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/admin/providers" });
    },
    onError: () => toast.error("Could not delete the provider."),
  });

  const removeModel = useMutation({
    mutationFn: (modelId: string) => deleteModel({ data: { modelId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not delete the model."),
  });

  if (!provider) {
    return (
      <Page title="Provider not found" backTo="/admin/providers" backLabel="Providers">
        <p className="text-muted-foreground text-sm">This provider does not exist anymore.</p>
      </Page>
    );
  }

  return (
    <Page
      title={provider.name}
      backTo="/admin/providers"
      backLabel="Providers"
      actions={
        <>
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel htmlFor={`${id}-enabled`} className="text-muted-foreground max-sm:sr-only">
              Enabled
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
              render={<Button variant="ghost" size="icon-sm" aria-label="Provider actions" />}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                Edit provider
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${provider.name}?`,
                      description:
                        "This removes the provider and all its models. Conversations that used them keep their history but can no longer generate with these models.",
                      confirmLabel: "Delete provider",
                    })
                  ) {
                    removeProvider.mutate();
                  }
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete provider
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
    >
      <Section title="Connection">
        <ListCard>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">Kind</span>
            <span className="text-sm">{PROVIDER_PRESETS[provider.kind].label}</span>
          </ListRow>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">Base URL</span>
            <span className="min-w-0 truncate font-mono text-sm">{provider.baseUrl}</span>
          </ListRow>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">API key</span>
            <span className="text-muted-foreground text-sm">Encrypted at rest</span>
          </ListRow>
        </ListCard>
      </Section>

      <Section
        title="Models"
        actions={
          <Button size="sm" onClick={() => setAddingModel(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            Add model
          </Button>
        }
      >
        {models.length === 0 ? (
          <EmptyState
            icon={AiBrain01Icon}
            title="No models yet"
            description="Add a model from this provider's catalog to make it selectable in chat."
            action={
              <Button size="sm" onClick={() => setAddingModel(true)}>
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                Add model
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
                <Badge variant="outline">{model.access === "public" ? "Public" : "Private"}</Badge>
                {!model.enabled ? <Badge variant="outline">Disabled</Badge> : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${model.displayName}`}
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
                  aria-label={`Delete ${model.displayName}`}
                  disabled={removeModel.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Delete ${model.displayName}?`,
                        description:
                          "The model disappears from the chat picker. Existing conversations keep their history.",
                        confirmLabel: "Delete model",
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

      <AddModelDialog providerId={providerId} open={addingModel} onOpenChange={setAddingModel} />

      <ModelEditDialog
        model={editingModel}
        open={editingModelOpen}
        onOpenChange={setEditingModelOpen}
      />

      <EditProviderDialog provider={provider} open={editing} onOpenChange={setEditing} />
    </Page>
  );
}

export function AddModelDialog({
  providerId,
  open,
  onOpenChange,
}: {
  providerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const selectedId = useRef<string | null>(null);
  const [pick, setPick] = useState<CatalogPick | null>(null);
  const [typed, setTyped] = useState("");
  const [draft, setDraft] = useState(emptyModelSettingsDraft);

  // Selecting from the popup (incl. the creatable row) is the primary path;
  // raw typed text works as a manual entry even without an explicit selection.
  const effective: CatalogPick | null =
    pick && (typed === "" || typed === pick.id)
      ? pick
      : typed.trim()
        ? { id: typed.trim(), name: typed.trim(), type: "chat", contextLength: null, custom: true }
        : null;
  const settings = modelSettingsFromDraft(draft);

  const reset = () => {
    selectedId.current = null;
    setPick(null);
    setTyped("");
    setDraft(emptyModelSettingsDraft());
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
      <DialogContent className={TALL_DIALOG_CLASS}>
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Search the provider's live catalog, or type a model ID if the catalog is unavailable.
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
              <FieldLabel htmlFor={`${id}-model`}>Model</FieldLabel>
              <ModelCombobox
                inputId={`${id}-model`}
                providerId={providerId}
                disabled={add.isPending}
                onPick={(picked) => {
                  selectedId.current = picked.id;
                  setPick(picked);
                  setTyped(picked.id);
                  setDraft((current) => ({
                    ...current,
                    displayName: picked.name,
                    type: picked.type,
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
                  }));
                }}
                onInput={(value) => {
                  setTyped(value);
                  if (value === selectedId.current) return;
                  selectedId.current = null;
                  setPick(null);
                  setDraft({ ...emptyModelSettingsDraft(), displayName: value.trim() });
                }}
              />
              {effective ? (
                <FieldDescription>
                  {effective.custom
                    ? "Custom model. Fill in the settings below."
                    : "Catalog defaults are filled in below and can be edited."}
                </FieldDescription>
              ) : null}
            </Field>

            {effective ? (
              <ModelSettingsFields
                draft={draft}
                setDraft={setDraft}
                groups={groups}
                disabled={add.isPending}
              />
            ) : null}
          </FieldGroup>

          {add.isError ? <FieldError>Could not add the model.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={add.isPending} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={effective === null || settings === null || add.isPending}
              aria-busy={add.isPending || undefined}
            >
              {add.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
              Add model
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditProviderDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: { id: string; name: string; baseUrl: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  // Empty means "keep the current key" — the stored key can't be shown.
  const [apiKey, setApiKey] = useState("");
  const complete = Boolean(name.trim() && baseUrl.trim());

  const save = useMutation({
    mutationFn: () =>
      updateProvider({
        data: {
          providerId: provider.id,
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
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
      setApiKey("");
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
          setBaseUrl(provider.baseUrl);
          setApiKey("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit provider</DialogTitle>
          <DialogDescription>Leave the API key empty to keep the current one.</DialogDescription>
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
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={save.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-base-url`}>Base URL</FieldLabel>
              <Input
                id={`${id}-base-url`}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                disabled={save.isPending}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-api-key`}>API key</FieldLabel>
              <Input
                id={`${id}-api-key`}
                type="password"
                autoComplete="off"
                placeholder="Unchanged"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={save.isPending}
              />
            </Field>
          </FieldGroup>
          {save.isError ? <FieldError>Could not save the provider.</FieldError> : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={!complete || save.isPending}
              aria-busy={save.isPending || undefined}
            >
              {save.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
