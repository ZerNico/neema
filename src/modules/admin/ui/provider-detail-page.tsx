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
import { useRef, useState } from "react";
import { createModel, deleteModel, deleteProvider, updateProvider } from "../server/functions.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
import { groupsQuery } from "./groups-page.tsx";
import { type CatalogPick, ModelCombobox } from "./model-combobox.tsx";
import { ModelEditDialog } from "./model-edit-dialog.tsx";
import {
  emptyModelSettingsDraft,
  ModelSettingsFields,
  modelSettingsFromDraft,
} from "./model-settings-form.tsx";
import { CapabilityIcons, ContextBadge } from "~/modules/providers/ui/capability-icons.tsx";
import { modelsQuery, PROVIDER_PRESETS, providersQuery } from "./providers-page.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
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
import { useConfirm } from "~/ui/confirm.tsx";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";

export function ProviderDetailPage({ providerId }: { providerId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: allModels } = useSuspenseQuery(modelsQuery);
  const [addingModel, setAddingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();

  const provider = providers.find((p) => p.id === providerId);
  const models = allModels.filter((m) => m.providerId === providerId);
  const editingModel = models.find((model) => model.id === editingModelId);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
    ]);

  const toggleProvider = useMutation({
    mutationFn: (enabled: boolean) => updateProvider({ data: { providerId, enabled } }),
    onSuccess: invalidate,
  });

  const removeProvider = useMutation({
    mutationFn: () => deleteProvider({ data: { providerId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/admin/providers" });
    },
  });

  const removeModel = useMutation({
    mutationFn: (modelId: string) => deleteModel({ data: { modelId } }),
    onSuccess: invalidate,
  });

  if (!provider) {
    return (
      <AdminPage title="Provider not found" backTo="/admin/providers" backLabel="Providers">
        <p className="text-muted-foreground text-sm">This provider does not exist anymore.</p>
      </AdminPage>
    );
  }

  return (
    <AdminPage
      title={provider.name}
      backTo="/admin/providers"
      backLabel="Providers"
      actions={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground hidden sm:inline">Enabled</span>
            <Switch
              checked={provider.enabled}
              onCheckedChange={(checked) => toggleProvider.mutate(checked)}
            />
          </label>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" aria-label="Provider actions" />}
            >
              <HugeiconsIcon icon={MoreVerticalIcon} className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
                Edit provider
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Delete ${provider?.name}?`,
                      description:
                        "This removes the provider and all its models. Conversations that used them keep their history but can no longer generate with these models.",
                      confirmLabel: "Delete provider",
                    })
                  ) {
                    removeProvider.mutate();
                  }
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                Delete provider
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
          Connection
        </h2>
        <ListCard>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">Kind</span>
            <span className="text-sm">{PROVIDER_PRESETS[provider.kind].label}</span>
          </ListRow>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">Base URL</span>
            <span className="truncate font-mono text-sm">{provider.baseUrl}</span>
          </ListRow>
          <ListRow>
            <span className="text-muted-foreground w-24 shrink-0 text-sm">API key</span>
            <span className="text-muted-foreground text-sm">•••••••• (encrypted)</span>
          </ListRow>
        </ListCard>
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Models
          </h2>
          <Button size="sm" variant="outline" onClick={() => setAddingModel(true)}>
            <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
            Add model
          </Button>
        </div>
        {models.length === 0 ? (
          <EmptyState
            icon={AiBrain01Icon}
            title="No models yet"
            description="Add a model from this provider's catalog to make it selectable in chat."
            action={
              <Button size="sm" onClick={() => setAddingModel(true)}>
                <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
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
                    {model.displayName}
                    <Badge variant="secondary">{model.type}</Badge>
                  </span>
                  <span className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
                    <span className="truncate">{model.modelKey}</span>
                    <ContextBadge contextLength={model.contextLength} />
                    <CapabilityIcons capabilities={model.capabilities} />
                  </span>
                </div>
                <Badge variant="outline">{model.access === "public" ? "Public" : "Private"}</Badge>
                {!model.enabled ? <Badge variant="outline">disabled</Badge> : null}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Edit ${model.displayName}`}
                  onClick={() => setEditingModelId(model.id)}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete ${model.displayName}`}
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
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        )}
      </section>

      <AddModelDialog providerId={providerId} open={addingModel} onOpenChange={setAddingModel} />

      {editingModel ? (
        <ModelEditDialog model={editingModel} onClose={() => setEditingModelId(null)} />
      ) : null}

      <EditProviderDialog provider={provider} open={editing} onOpenChange={setEditing} />
    </AdminPage>
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
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Search the provider's live catalog, or type a model id if the catalog is unavailable.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (effective !== null && settings !== null) add.mutate();
          }}
        >
          <Field>
            <FieldLabel>Model</FieldLabel>
            <ModelCombobox
              providerId={providerId}
              onPick={(picked) => {
                selectedId.current = picked.id;
                setPick(picked);
                setTyped(picked.id);
                setDraft((current) => ({
                  ...current,
                  displayName: picked.name,
                  type: picked.type,
                  contextLength: picked.contextLength === null ? "" : String(picked.contextLength),
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
          </Field>

          {effective ? (
            <>
              <ModelSettingsFields draft={draft} setDraft={setDraft} groups={groups} />
              <p className="text-muted-foreground text-xs">
                {effective.id}
                {effective.custom ? " · custom model" : " · catalog defaults are editable"}
              </p>
            </>
          ) : null}

          {add.isError ? (
            <p className="text-destructive text-sm">Could not add the model.</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={effective === null || settings === null || add.isPending}
            >
              {add.isPending ? "Adding…" : "Add model"}
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
  const queryClient = useQueryClient();
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  // Empty means "keep the current key" — the stored key can't be shown.
  const [apiKey, setApiKey] = useState("");

  const save = useMutation({
    mutationFn: () =>
      updateProvider({
        data: {
          providerId: provider.id,
          name,
          baseUrl,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      }),
    onSuccess: () => {
      onOpenChange(false);
      setApiKey("");
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
      // Base URL or key changes invalidate the cached model catalog too.
      void queryClient.invalidateQueries({ queryKey: ["provider-catalog", provider.id] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit provider</DialogTitle>
          <DialogDescription>Leave the API key empty to keep the current one.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>API key</FieldLabel>
            <Input
              type="password"
              autoComplete="off"
              placeholder="•••••••• (unchanged)"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !baseUrl.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
