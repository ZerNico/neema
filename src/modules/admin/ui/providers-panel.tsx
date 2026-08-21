import { Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { queryOptions } from "@tanstack/react-query";
import { useState } from "react";
import {
  createModel,
  createProvider,
  deleteModel,
  deleteProvider,
  listModels,
  listProviders,
  updateModel,
  updateProvider,
} from "../server/functions.ts";
import { type CatalogPick, ModelCombobox } from "./model-combobox.tsx";
import { Badge } from "~/shared/ui/primitives/badge";
import { Button } from "~/shared/ui/primitives/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/shared/ui/primitives/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/shared/ui/primitives/dialog";
import { Field, FieldLabel } from "~/shared/ui/primitives/field";
import { Input } from "~/shared/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/shared/ui/primitives/select";
import { Separator } from "~/shared/ui/primitives/separator";

export const providersQuery = queryOptions({
  queryKey: ["admin", "providers"],
  queryFn: () => listProviders(),
});

export const modelsQuery = queryOptions({
  queryKey: ["admin", "models"],
  queryFn: () => listModels(),
});

const PROVIDER_PRESETS = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: "" },
} as const;

export function ProvidersPanel() {
  const queryClient = useQueryClient();
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    name: string;
    kind: keyof typeof PROVIDER_PRESETS;
    baseUrl: string;
    apiKey: string;
  }>({
    name: "",
    kind: "openrouter",
    baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
    apiKey: "",
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

  const addProvider = useMutation({
    mutationFn: () => createProvider({ data: draft }),
    onSuccess: () => {
      setAdding(false);
      setDraft({
        name: "",
        kind: "openrouter",
        baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
        apiKey: "",
      });
      return invalidate();
    },
  });

  const removeProvider = useMutation({
    mutationFn: (providerId: string) => deleteProvider({ data: { providerId } }),
    onSuccess: invalidate,
  });

  const toggleProvider = useMutation({
    mutationFn: (input: { providerId: string; enabled: boolean }) =>
      updateProvider({ data: input }),
    onSuccess: invalidate,
  });

  const addModel = useMutation({
    mutationFn: (input: { providerId: string; pick: CatalogPick }) =>
      createModel({
        data: {
          providerId: input.providerId,
          modelKey: input.pick.id,
          displayName: input.pick.name,
          type: input.pick.type,
          ...(input.pick.contextLength ? { contextLength: input.pick.contextLength } : {}),
        },
      }),
    onSuccess: invalidate,
  });

  const removeModel = useMutation({
    mutationFn: (modelId: string) => deleteModel({ data: { modelId } }),
    onSuccess: invalidate,
  });

  const toggleModel = useMutation({
    mutationFn: (input: { modelId: string; enabled: boolean }) => updateModel({ data: input }),
    onSuccess: invalidate,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Providers</h2>
        <Button onClick={() => setAdding(true)}>
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          Add provider
        </Button>
      </div>

      {providers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No providers yet. Add one (e.g. OpenRouter) to start chatting.
        </p>
      ) : null}

      {providers.map((provider) => {
        const providerModels = models.filter((m) => m.providerId === provider.id);
        return (
          <Card key={provider.id}>
            <CardHeader className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <CardTitle>{provider.name}</CardTitle>
                <Badge variant="secondary">{provider.kind}</Badge>
                {!provider.enabled ? <Badge variant="outline">disabled</Badge> : null}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    toggleProvider.mutate({
                      providerId: provider.id,
                      enabled: !provider.enabled,
                    })
                  }
                >
                  {provider.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete provider"
                  onClick={() => removeProvider.mutate(provider.id)}
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground text-xs">{provider.baseUrl}</p>
              <Separator />
              <div className="flex flex-col gap-2">
                {providerModels.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">{model.displayName}</span>
                      <span className="text-muted-foreground text-xs">
                        {model.modelKey} · {model.type}
                        {model.contextLength
                          ? ` · ${Math.round(model.contextLength / 1000)}k ctx`
                          : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {!model.enabled ? <Badge variant="outline">disabled</Badge> : null}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          toggleModel.mutate({ modelId: model.id, enabled: !model.enabled })
                        }
                      >
                        {model.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete model"
                        onClick={() => removeModel.mutate(model.id)}
                      >
                        <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Field>
                <FieldLabel>Add model</FieldLabel>
                <ModelCombobox
                  providerId={provider.id}
                  onPick={(pick) => addModel.mutate({ providerId: provider.id, pick })}
                />
              </Field>
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add provider</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <Select
                value={draft.kind}
                onValueChange={(kind) => {
                  if (!kind) return;
                  const k = kind as keyof typeof PROVIDER_PRESETS;
                  setDraft((d) => ({
                    ...d,
                    kind: k,
                    baseUrl: PROVIDER_PRESETS[k].baseUrl || d.baseUrl,
                    name: d.name || PROVIDER_PRESETS[k].label,
                  }));
                }}
                items={Object.entries(PROVIDER_PRESETS).map(([value, preset]) => ({
                  value,
                  label: preset.label,
                }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PROVIDER_PRESETS).map(([value, preset]) => (
                    <SelectItem key={value} value={value}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="OpenRouter"
              />
            </Field>
            <Field>
              <FieldLabel>Base URL</FieldLabel>
              <Input
                value={draft.baseUrl}
                onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                placeholder="https://openrouter.ai/api/v1"
              />
            </Field>
            <Field>
              <FieldLabel>API key</FieldLabel>
              <Input
                type="password"
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              disabled={!draft.name || !draft.baseUrl || !draft.apiKey || addProvider.isPending}
              onClick={() => addProvider.mutate()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
