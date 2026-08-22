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
import { useState } from "react";
import {
  createModel,
  deleteModel,
  deleteProvider,
  updateModel,
  updateProvider,
} from "../server/functions.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
import { type CatalogPick, ModelCombobox } from "./model-combobox.tsx";
import {
  CAPABILITY_META,
  type Capabilities,
  CapabilityIcons,
  ContextBadge,
} from "~/modules/providers/ui/capability-icons.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Switch } from "~/ui/primitives/switch";

const MODEL_TYPES = ["chat", "embedding", "image", "audio"] as const;

export function ProviderDetailPage({ providerId }: { providerId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: allModels } = useSuspenseQuery(modelsQuery);
  const [addingModel, setAddingModel] = useState(false);
  const [editing, setEditing] = useState(false);
  const confirm = useConfirm();

  const provider = providers.find((p) => p.id === providerId);
  const models = allModels.filter((m) => m.providerId === providerId);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

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

  const toggleModel = useMutation({
    mutationFn: (input: { modelId: string; enabled: boolean }) => updateModel({ data: input }),
    onSuccess: invalidate,
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
                <Switch
                  checked={model.enabled}
                  onCheckedChange={(enabled) => toggleModel.mutate({ modelId: model.id, enabled })}
                  aria-label={`${model.displayName} enabled`}
                />
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

      <EditProviderDialog provider={provider} open={editing} onOpenChange={setEditing} />
    </AdminPage>
  );
}

function AddModelDialog({
  providerId,
  open,
  onOpenChange,
}: {
  providerId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [pick, setPick] = useState<CatalogPick | null>(null);
  const [typed, setTyped] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [customType, setCustomType] = useState<CatalogPick["type"]>("chat");
  const [capabilities, setCapabilities] = useState<Capabilities>({
    reasoning: false,
    tools: false,
    vision: false,
    files: false,
  });

  // Selecting from the popup (incl. the creatable row) is the primary path;
  // raw typed text works as a manual entry even without an explicit selection.
  const effective: CatalogPick | null =
    pick && (typed === "" || typed === pick.id)
      ? pick
      : typed.trim()
        ? { id: typed.trim(), name: typed.trim(), type: "chat", contextLength: null, custom: true }
        : null;
  const isCustom = effective?.custom ?? false;

  const add = useMutation({
    mutationFn: (input: { pick: CatalogPick; displayName: string }) =>
      createModel({
        data: {
          providerId,
          modelKey: input.pick.id,
          displayName: input.displayName || input.pick.name,
          type: input.pick.custom ? customType : input.pick.type,
          capabilities,
          ...(input.pick.contextLength ? { contextLength: input.pick.contextLength } : {}),
        },
      }),
    onSuccess: () => {
      // Close immediately; the list refreshes in the background.
      onOpenChange(false);
      setPick(null);
      setTyped("");
      setDisplayName("");
      setCustomType("chat");
      setCapabilities({ reasoning: false, tools: false, vision: false, files: false });
      void queryClient.invalidateQueries({ queryKey: ["admin"] });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add model</DialogTitle>
          <DialogDescription>
            Search the provider's live catalog, or type a model id if the catalog is unavailable.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel>Model</FieldLabel>
            <ModelCombobox
              providerId={providerId}
              onPick={(picked) => {
                setPick(picked);
                setTyped(picked.id);
                setDisplayName(picked.custom ? "" : picked.name);
                // Auto-detected from the catalog; still editable below.
                setCapabilities(
                  picked.capabilities ?? {
                    reasoning: false,
                    tools: false,
                    vision: false,
                    files: false,
                  },
                );
              }}
              onInput={setTyped}
            />
          </Field>
          {isCustom ? (
            <Field>
              <FieldLabel>Type</FieldLabel>
              <Select
                value={customType}
                onValueChange={(t) => t && setCustomType(t as CatalogPick["type"])}
                items={MODEL_TYPES.map((t) => ({ value: t, label: t }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODEL_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : null}
          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={effective?.id ?? "Shown in the model picker"}
            />
          </Field>
          {effective ? (
            <Field>
              <FieldLabel>Capabilities</FieldLabel>
              <div className="flex flex-col gap-2">
                {CAPABILITY_META.map((cap) => (
                  <label key={cap.key} className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={capabilities[cap.key]}
                      onCheckedChange={(checked) =>
                        setCapabilities((c) => ({ ...c, [cap.key]: checked }))
                      }
                    />
                    <HugeiconsIcon icon={cap.icon} className="text-muted-foreground size-4" />
                    {cap.label}
                  </label>
                ))}
              </div>
              {!isCustom ? (
                <p className="text-muted-foreground text-xs">Detected from the catalog.</p>
              ) : null}
            </Field>
          ) : null}
          {effective ? (
            <p className="text-muted-foreground text-xs">
              {effective.id} · {isCustom ? customType : effective.type}
              {effective.contextLength
                ? ` · ${Math.round(effective.contextLength / 1000)}k context`
                : ""}
              {isCustom ? " · custom model" : ""}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!effective || add.isPending}
            onClick={() => effective && add.mutate({ pick: effective, displayName })}
          >
            {add.isPending ? "Adding…" : "Add model"}
          </Button>
        </DialogFooter>
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
