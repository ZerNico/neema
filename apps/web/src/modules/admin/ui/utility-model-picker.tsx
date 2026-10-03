import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { getUtilityModel, updateUtilityModel } from "../server/functions.ts";

const utilityKey = ["admin", "utility-model"];

/**
 * The model small side tasks run on; empty means each chat's own. It reads
 * every chat's first message, and falls back to the chat's model if it fails.
 */
export function UtilityModelPicker({
  models,
  providers,
}: {
  models: ReadonlyArray<Pick<ModelRow, "id" | "providerId" | "displayName" | "type">>;
  providers: ReadonlyArray<Pick<PublicProvider, "id" | "name">>;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey: utilityKey, queryFn: () => getUtilityModel() });
  const save = useMutation({
    mutationFn: (modelId: string | null) => updateUtilityModel({ data: { modelId } }),
    onError: () => toast.error("Could not save the title model. Refresh and try again."),
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
    <Section title="Chat titles">
      <ListCard>
        <ListRow className="flex-wrap">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">Title model</span>
            <span className="text-muted-foreground text-xs">
              Names new chats. A fast model works best.
            </span>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <ModelSelect
              aria-label="Title model"
              models={options}
              value={value}
              onChange={(id) => save.mutate(id)}
              placeholder="Each chat’s own model"
              disabled={current.isPending}
              className="w-full min-w-0 sm:w-64"
            />
            {value ? (
              <Button variant="ghost" onClick={() => save.mutate(null)}>
                Clear
              </Button>
            ) : null}
          </div>
        </ListRow>
      </ListCard>
    </Section>
  );
}
