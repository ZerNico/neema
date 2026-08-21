import { ArrowRight01Icon, CloudServerIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createProvider, listModels, listProviders } from "../server/functions.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
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
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";

export const providersQuery = queryOptions({
  queryKey: ["admin", "providers"],
  queryFn: () => listProviders(),
});

export const modelsQuery = queryOptions({
  queryKey: ["admin", "models"],
  queryFn: () => listModels(),
});

export const PROVIDER_PRESETS = {
  openrouter: { label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  "openai-compatible": { label: "OpenAI-compatible", baseUrl: "" },
} as const;

export function ProvidersPage() {
  const { data: providers } = useSuspenseQuery(providersQuery);
  const { data: models } = useSuspenseQuery(modelsQuery);
  const [adding, setAdding] = useState(false);

  return (
    <AdminPage
      title="Providers"
      description="AI providers this instance can talk to."
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          Add provider
        </Button>
      }
    >
      {providers.length === 0 ? (
        <EmptyState
          icon={CloudServerIcon}
          title="No providers yet"
          description="Connect a provider like OpenRouter to make models available for chat."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
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
                <ListRow className="hover:bg-accent/50 transition-colors">
                  <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                    <HugeiconsIcon icon={CloudServerIcon} className="size-4" />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {provider.name}
                      {!provider.enabled ? <Badge variant="outline">disabled</Badge> : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">
                      {PROVIDER_PRESETS[provider.kind].label} ·{" "}
                      {modelCount === 1 ? "1 model" : `${modelCount} models`}
                    </span>
                  </div>
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                </ListRow>
              </Link>
            );
          })}
        </ListCard>
      )}
      <AddProviderDialog open={adding} onOpenChange={setAdding} />
    </AdminPage>
  );
}

function AddProviderDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<{
    name: string;
    kind: keyof typeof PROVIDER_PRESETS;
    baseUrl: string;
    apiKey: string;
  }>({
    name: "OpenRouter",
    kind: "openrouter",
    baseUrl: PROVIDER_PRESETS.openrouter.baseUrl,
    apiKey: "",
  });

  const add = useMutation({
    mutationFn: () => createProvider({ data: draft }),
    onSuccess: async (provider) => {
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      onOpenChange(false);
      // Jump straight into the detail page so models can be added immediately.
      await navigate({
        to: "/admin/providers/$providerId",
        params: { providerId: provider.id },
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add provider</DialogTitle>
          <DialogDescription>
            The API key is encrypted at rest and never shown again.
          </DialogDescription>
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
                  name:
                    d.name === "" || d.name === PROVIDER_PRESETS[d.kind].label
                      ? PROVIDER_PRESETS[k].label
                      : d.name,
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
              autoComplete="off"
              value={draft.apiKey}
              onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!draft.name || !draft.baseUrl || !draft.apiKey || add.isPending}
            onClick={() => add.mutate()}
          >
            {add.isPending ? "Adding…" : "Add provider"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
