import { ArrowDown01Icon, ArrowUp01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { MAX_DEFAULT_MODELS } from "~/modules/providers/default-models.ts";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { ListCard, ListRow } from "~/ui/page-shell.tsx";
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
import { Field, FieldDescription, FieldLabel } from "~/ui/primitives/field";
import {
  getUtilityModel,
  updateDefaultModelOrder,
  updateUtilityModel,
} from "../server/functions.ts";

type PriorityModel = Pick<
  ModelRow,
  "id" | "providerId" | "displayName" | "type" | "enabled" | "defaultPriority"
>;
type Providers = ReadonlyArray<Pick<PublicProvider, "id" | "name" | "enabled">>;

/** Rarely changed, so it lives behind a button rather than on the providers page. */
export function DefaultModelsDialog({
  open,
  onOpenChange,
  models,
  providers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: ReadonlyArray<PriorityModel>;
  providers: Providers;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Default models</DialogTitle>
          <DialogDescription>
            New chats start with the first model here that the person can use. People keep the model
            they last picked. Changes save right away.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <>
            <DefaultModelOrder models={models} providers={providers} />
            <UtilityModelPicker models={models} providers={providers} />
          </>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const mutationKey = ["admin", "save-default-model-order"];

export function DefaultModelOrder({
  models,
  providers,
}: {
  models: ReadonlyArray<PriorityModel>;
  providers: Providers;
}) {
  const queryClient = useQueryClient();
  // The last order chosen, shown until the final queued save settles and the
  // refetch returns, so no refetch in between can show an older one.
  const [draft, setDraft] = useState<string[] | null>(null);
  const chatModel = (id: string) =>
    models.find((model) => model.id === id && model.type === "chat");
  const saved = models
    .filter((model) => model.type === "chat" && model.defaultPriority !== null)
    // Sorting the filtered copy; the client targets ES2022, before toSorted.
    // oxlint-disable-next-line unicorn/no-array-sort
    .sort((a, b) => a.defaultPriority! - b.defaultPriority! || a.id.localeCompare(b.id))
    .map((model) => model.id);
  // A model deleted meanwhile simply drops out; the next save omits it too.
  const order = (draft ?? saved).filter((id) => chatModel(id));
  const providerOf = (model: PriorityModel) =>
    providers.find((provider) => provider.id === model.providerId);
  const options = models
    .filter((model) => model.type === "chat" && !order.includes(model.id))
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerName: providerOf(model)?.name ?? "Unavailable provider",
    }));
  const full = order.length >= MAX_DEFAULT_MODELS;

  // Saves run one at a time in the order made, each carrying the whole list.
  const save = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: (modelIds: string[]) => updateDefaultModelOrder({ data: { modelIds } }),
    onError: () =>
      toast.error(
        "Could not save the default models. Refresh the page if a model was removed, then try again.",
      ),
    onSettled: async () => {
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "models"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      ]);
      setDraft(null);
    },
  });
  const apply = (next: string[]) => {
    setDraft(next);
    save.mutate(next);
  };
  const move = (index: number, offset: number) => {
    const next = [...order];
    [next[index], next[index + offset]] = [next[index + offset]!, next[index]!];
    apply(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {order.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No models listed yet, so new chats start with the first model alphabetically.
        </p>
      ) : (
        <ListCard>
          <ol className="divide-y">
            {order.map((id, index) => {
              const model = chatModel(id)!;
              const provider = providerOf(model);
              const skipped = !model.enabled || !provider?.enabled;
              const providerName = provider?.name ?? "Unavailable provider";
              // Names repeat across providers, so controls say which one.
              const name = `${model.displayName} · ${providerName}`;
              return (
                <li key={id}>
                  <ListRow>
                    <span
                      className="text-muted-foreground w-5 shrink-0 text-center text-xs tabular-nums"
                      aria-hidden
                    >
                      {index + 1}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium" title={model.displayName}>
                        {model.displayName}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {providerName}
                        {skipped ? " · Disabled, skipped" : ""}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Move ${name} up`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Move ${name} down`}
                        disabled={index === order.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Remove ${name}`}
                        onClick={() => apply(order.filter((entry) => entry !== id))}
                      >
                        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                      </Button>
                    </div>
                  </ListRow>
                </li>
              );
            })}
          </ol>
        </ListCard>
      )}
      <ModelSelect
        models={options}
        value={null}
        onChange={(id) => {
          if (id && !full) apply([...order, id]);
        }}
        aria-label="Add a model"
        placeholder={full ? `Up to ${MAX_DEFAULT_MODELS} models` : "Add a model…"}
        emptyPlaceholder="Every chat model is already listed"
        disabled={full}
        className="w-full min-w-0"
      />
    </div>
  );
}

const utilityKey = ["admin", "utility-model"];

/** The model small side tasks run on; empty means each chat's own model. */
export function UtilityModelPicker({
  models,
  providers,
}: {
  models: ReadonlyArray<PriorityModel>;
  providers: Providers;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: utilityKey, queryFn: () => getUtilityModel() });
  const save = useMutation({
    mutationFn: (modelId: string | null) => updateUtilityModel({ data: { modelId } }),
    onError: () =>
      toast.error(
        "Could not save the title model. Refresh the page if it was removed, then try again.",
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: utilityKey }),
  });
  const options = models
    .filter((model) => model.type === "chat")
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerName:
        providers.find((provider) => provider.id === model.providerId)?.name ??
        "Unavailable provider",
    }));
  const value = save.isPending ? (save.variables ?? null) : (current.data?.modelId ?? null);
  return (
    <Field>
      <FieldLabel htmlFor="utility-model">Model for chat titles</FieldLabel>
      <div className="flex gap-2">
        <ModelSelect
          id="utility-model"
          models={options}
          value={value}
          onChange={(id) => save.mutate(id)}
          placeholder="Each chat’s own model"
          disabled={current.isPending}
          className="w-full min-w-0"
        />
        {value ? (
          <Button variant="ghost" onClick={() => save.mutate(null)}>
            Clear
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        Writes the short title of each new chat. A fast, inexpensive model is enough; if it fails,
        the chat’s own model writes the title instead.
      </FieldDescription>
    </Field>
  );
}
