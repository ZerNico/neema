import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ListCard, ListRow } from "~/ui/page-shell.tsx";
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
  SortableHandle,
  SortableItem,
  SortableList,
  SortableMoveButtons,
} from "~/ui/sortable-list.tsx";
import { moveId } from "~/ui/move-id.ts";
import { updateDefaultModelOrder } from "../server/functions.ts";

type PriorityModel = Pick<
  ModelRow,
  "id" | "providerId" | "displayName" | "type" | "enabled" | "defaultPriority"
>;
type Providers = ReadonlyArray<Pick<PublicProvider, "id" | "name" | "enabled">>;

/** Rarely changed, so it lives behind a button rather than on the providers page. */
export function ModelOrderDialog({
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
          <DialogTitle>Model order</DialogTitle>
          <DialogDescription>
            Model pickers list chat models in this order, and new chats start with the first one the
            person can use. Changes save right away.
          </DialogDescription>
        </DialogHeader>
        {open ? <ModelOrder models={models} providers={providers} /> : null}
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const mutationKey = ["admin", "save-default-model-order"];

// Placed models first, then the rest alphabetically: the order chat pickers receive.
const byRank = (a: PriorityModel, b: PriorityModel) =>
  (a.defaultPriority ?? Number.POSITIVE_INFINITY) -
    (b.defaultPriority ?? Number.POSITIVE_INFINITY) ||
  a.displayName.localeCompare(b.displayName) ||
  a.id.localeCompare(b.id);

export function ModelOrder({
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
  const chatModels = models.filter((model) => model.type === "chat");
  // Sorting the filtered copy; the client targets ES2022, before toSorted.
  // oxlint-disable-next-line unicorn/no-array-sort
  const saved = chatModels.sort(byRank).map((model) => model.id);
  // A model deleted meanwhile drops out, and one added meanwhile joins the end.
  const order = draft
    ? [...draft.filter((id) => saved.includes(id)), ...saved.filter((id) => !draft.includes(id))]
    : saved;
  const modelOf = (id: string) => chatModels.find((model) => model.id === id)!;
  const providerOf = (model: PriorityModel) =>
    providers.find((provider) => provider.id === model.providerId);
  const usable = (model: PriorityModel) => model.enabled && providerOf(model)?.enabled === true;
  const firstUsable = order.find((id) => usable(modelOf(id)));

  // Saves run one at a time in the order made, each carrying the whole list.
  const save = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: (modelIds: string[]) => updateDefaultModelOrder({ data: { modelIds } }),
    onError: () =>
      toast.error(
        "Could not save the model order. Refresh the page if a model was removed, then try again.",
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
  const move = (from: number, to: number) => apply(moveId(order, from, to));

  if (order.length === 0) {
    return <p className="text-muted-foreground text-sm">No chat models yet.</p>;
  }
  return (
    <ListCard className="max-h-[50vh] overflow-y-auto">
      <SortableList onMove={move} className="divide-y">
        {order.map((id, index) => {
          const model = modelOf(id);
          const providerName = providerOf(model)?.name ?? "Unavailable provider";
          // Names repeat across providers, so controls say which one.
          const name = `${model.displayName} · ${providerName}`;
          return (
            <SortableItem key={id} id={id} index={index}>
              {/* oxlint-disable-next-line shadcn/no-restyle -- the drag handle sits in the row's leading padding */}
              <ListRow className="py-2 pl-2">
                <SortableHandle label={name} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    <span className="truncate" title={model.displayName}>
                      {model.displayName}
                    </span>
                    {id === firstUsable ? <Badge variant="secondary">Default</Badge> : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {providerName}
                    {usable(model) ? "" : " · Disabled, skipped"}
                  </span>
                </div>
                <div className="flex shrink-0 gap-1">
                  <SortableMoveButtons
                    label={name}
                    index={index}
                    count={order.length}
                    onMove={move}
                  />
                </div>
              </ListRow>
            </SortableItem>
          );
        })}
      </SortableList>
    </ListCard>
  );
}
