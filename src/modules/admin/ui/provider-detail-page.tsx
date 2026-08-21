import {
  AiBrain01Icon,
  Delete02Icon,
  MoreVerticalIcon,
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
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";

export function ProviderDetailPage({ providerId }: { providerId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: allModels } = useSuspenseQuery(modelsQuery);
  const [addingModel, setAddingModel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
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
                  <span className="text-muted-foreground truncate text-xs">
                    {model.modelKey}
                    {model.contextLength
                      ? ` · ${Math.round(model.contextLength / 1000)}k context`
                      : ""}
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
                  onClick={() => removeModel.mutate(model.id)}
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        )}
      </section>

      <AddModelDialog providerId={providerId} open={addingModel} onOpenChange={setAddingModel} />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {provider.name}?</DialogTitle>
            <DialogDescription>
              This removes the provider and all its models. Conversations that used them keep their
              history but can no longer generate with these models.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removeProvider.isPending}
              onClick={() => removeProvider.mutate()}
            >
              {removeProvider.isPending ? "Deleting…" : "Delete provider"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  const [freeText, setFreeText] = useState("");
  const [displayName, setDisplayName] = useState("");

  // Catalog pick wins; otherwise fall back to whatever id was typed.
  const effective: CatalogPick | null =
    pick ??
    (freeText.trim()
      ? { id: freeText.trim(), name: freeText.trim(), type: "chat", contextLength: null }
      : null);

  const add = useMutation({
    mutationFn: (input: { pick: CatalogPick; displayName: string }) =>
      createModel({
        data: {
          providerId,
          modelKey: input.pick.id,
          displayName: input.displayName || input.pick.name,
          type: input.pick.type,
          ...(input.pick.contextLength ? { contextLength: input.pick.contextLength } : {}),
        },
      }),
    onSuccess: () => {
      // Close immediately; the list refreshes in the background.
      onOpenChange(false);
      setPick(null);
      setFreeText("");
      setDisplayName("");
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
                setDisplayName(picked.name);
              }}
              onFreeText={(text) => {
                setFreeText(text);
                // Typing again invalidates a previous selection unless it matches.
                if (pick && text !== pick.id) setPick(null);
              }}
            />
          </Field>
          <Field>
            <FieldLabel>Display name</FieldLabel>
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={pick?.name ?? "Shown in the model picker"}
            />
          </Field>
          {effective ? (
            <p className="text-muted-foreground text-xs">
              {effective.id} · {effective.type}
              {effective.contextLength
                ? ` · ${Math.round(effective.contextLength / 1000)}k context`
                : ""}
              {!pick ? " · manual entry" : ""}
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
