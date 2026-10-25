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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/ui/primitives/tabs";
import { m } from "~/paraglide/messages.js";

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
  const hasImages = models.some((model) => model.type === "image");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{m.admin_order_title()}</DialogTitle>
          <DialogDescription>{m.admin_order_description()}</DialogDescription>
        </DialogHeader>
        {open && hasImages ? (
          <Tabs defaultValue="chat">
            <TabsList>
              <TabsTrigger value="chat">{m.admin_order_tab_chat()}</TabsTrigger>
              <TabsTrigger value="image">{m.admin_order_tab_image()}</TabsTrigger>
            </TabsList>
            <TabsContent value="chat">
              <ModelOrder models={models} providers={providers} type="chat" />
            </TabsContent>
            <TabsContent value="image">
              <ModelOrder models={models} providers={providers} type="image" />
            </TabsContent>
          </Tabs>
        ) : open ? (
          <ModelOrder models={models} providers={providers} type="chat" />
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button />}>{m.common_done()}</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const mutationKeyOf = (type: "chat" | "image") => ["admin", "save-default-model-order", type];

// Placed models first, then the rest alphabetically: the order chat pickers receive.
const byRank = (a: PriorityModel, b: PriorityModel) =>
  (a.defaultPriority ?? Number.POSITIVE_INFINITY) -
    (b.defaultPriority ?? Number.POSITIVE_INFINITY) ||
  a.displayName.localeCompare(b.displayName) ||
  a.id.localeCompare(b.id);

export function ModelOrder({
  models,
  providers,
  type = "chat",
}: {
  models: ReadonlyArray<PriorityModel>;
  providers: Providers;
  /** Each type keeps its own order; saving one leaves the other as it is. */
  type?: "chat" | "image";
}) {
  const mutationKey = mutationKeyOf(type);
  const queryClient = useQueryClient();
  // The last order chosen, shown until the final queued save settles and the
  // refetch returns, so no refetch in between can show an older one.
  const [draft, setDraft] = useState<string[] | null>(null);
  const chatModels = models.filter((model) => model.type === type);
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
    mutationFn: (modelIds: string[]) => updateDefaultModelOrder({ data: { modelIds, type } }),
    onError: () => toast.error(m.admin_order_error_save()),
    onSettled: async () => {
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin", "models"] }),
        queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
        queryClient.invalidateQueries({ queryKey: ["image-models"] }),
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
    return (
      <p className="text-muted-foreground text-sm">
        {type === "image" ? m.admin_order_empty_image() : m.admin_order_empty_chat()}
      </p>
    );
  }
  return (
    <ListCard className="max-h-[50vh] overflow-y-auto">
      <SortableList onMove={move} className="divide-y">
        {order.map((id, index) => {
          const model = modelOf(id);
          const providerName = providerOf(model)?.name ?? m.admin_utility_unavailable_provider();
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
                    {id === firstUsable ? (
                      <Badge variant="secondary">{m.admin_order_default()}</Badge>
                    ) : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {providerName}
                    {usable(model) ? "" : ` · ${m.admin_order_skipped()}`}
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
