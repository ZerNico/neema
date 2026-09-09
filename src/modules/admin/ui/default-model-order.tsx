import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { MAX_DEFAULT_MODELS } from "~/modules/providers/default-models.ts";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { FormActions, ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { updateDefaultModelOrder } from "../server/functions.ts";

type PriorityModel = Pick<
  ModelRow,
  "id" | "providerId" | "displayName" | "type" | "enabled" | "defaultPriority"
>;

export function DefaultModelOrder({
  models,
  providers,
}: {
  models: ReadonlyArray<PriorityModel>;
  providers: ReadonlyArray<Pick<PublicProvider, "id" | "name" | "enabled">>;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string[] | null>(null);
  const [candidate, setCandidate] = useState<string | null>(null);
  const saved = models
    .filter((model) => model.type === "chat" && model.defaultPriority !== null)
    // Sorting the filtered copy; the client targets ES2022, before toSorted.
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => a.defaultPriority! - b.defaultPriority! || a.id.localeCompare(b.id))
    .map((model) => model.id);
  const order = draft ?? saved;
  const dirty = order.length !== saved.length || order.some((id, index) => id !== saved[index]);
  const available = models.filter((model) => model.type === "chat" && !order.includes(model.id));
  const valid = order.every((id) =>
    models.some((model) => model.id === id && model.type === "chat"),
  );
  const providerName = (model: PriorityModel) =>
    providers.find((provider) => provider.id === model.providerId)?.name ?? "Unavailable provider";
  const label = (model: PriorityModel) => `${model.displayName} · ${providerName(model)}`;
  const options = available.map((model) => ({
    id: model.id,
    displayName: model.displayName,
    providerName: providerName(model),
  }));
  const selectedCandidate = available.some((model) => model.id === candidate) ? candidate : null;

  const save = useMutation({
    mutationFn: (modelIds: string[]) => updateDefaultModelOrder({ data: { modelIds } }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "models"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      ]);
      setDraft(null);
    },
    onError: () =>
      toast.error(
        "Could not save default model order. Refresh the list if a model was removed, then try again.",
      ),
  });
  const move = (index: number, offset: number) => {
    const next = [...order];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    setDraft(next);
  };

  return (
    <Section
      title="Default model order"
      description="New chats use the first enabled model in this list that the user can access. If none match, the first available model alphabetically is used. Existing selections and the model picker order stay unchanged."
    >
      <ListCard>
        {order.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">
            No preferred models. Defaults follow alphabetical order.
          </p>
        ) : (
          <ol className="divide-y">
            {order.map((id, index) => {
              const model = models.find((entry) => entry.id === id && entry.type === "chat");
              const name = model ? label(model) : "Unavailable model";
              const disabled =
                model &&
                (!model.enabled ||
                  !providers.find((provider) => provider.id === model.providerId)?.enabled);
              return (
                <li key={id}>
                  <ListRow>
                    <span
                      className="text-muted-foreground w-5 shrink-0 text-center text-xs tabular-nums"
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium" title={name}>
                        {name}
                      </p>
                      {!model ? (
                        <p className="text-destructive text-xs">Remove this entry before saving.</p>
                      ) : null}
                      {disabled ? <Badge variant="outline">Disabled · skipped</Badge> : null}
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Move ${name} up`}
                        disabled={save.isPending || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Move ${name} down`}
                        disabled={save.isPending || index === order.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${name}`}
                        disabled={save.isPending}
                        onClick={() => setDraft(order.filter((entry) => entry !== id))}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    </div>
                  </ListRow>
                </li>
              );
            })}
          </ol>
        )}
      </ListCard>
      <FormActions>
        <ModelSelect
          models={options}
          value={selectedCandidate}
          onChange={setCandidate}
          aria-label="Model to add"
          className="w-full min-w-0 sm:w-80"
          emptyPlaceholder="Every chat model is already listed"
          disabled={save.isPending || order.length >= MAX_DEFAULT_MODELS}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending || !selectedCandidate || order.length >= MAX_DEFAULT_MODELS}
          onClick={() => {
            if (selectedCandidate) setDraft([...order, selectedCandidate]);
            setCandidate(null);
          }}
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
          Add model
        </Button>
      </FormActions>
      <FormActions>
        <PendingButton
          size="sm"
          pending={save.isPending}
          disabled={!dirty || !valid}
          onClick={() => save.mutate([...order])}
        >
          Save
        </PendingButton>
        <Button
          size="sm"
          variant="outline"
          disabled={save.isPending || !dirty}
          onClick={() => {
            setDraft(null);
            setCandidate(null);
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={save.isPending || order.length === 0}
          onClick={() => setDraft([])}
        >
          Clear order
        </Button>
      </FormActions>
    </Section>
  );
}
