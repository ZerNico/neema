import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { getUtilityModel, updateUtilityModel } from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

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
    onError: () => toast.error(m.admin_utility_error_save()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: utilityKey }),
  });
  const options = models
    .filter((model) => model.type === "chat")
    .map((model) => ({
      id: model.id,
      displayName: model.displayName,
      providerName:
        providers.find((provider) => provider.id === model.providerId)?.name ??
        m.admin_utility_unavailable_provider(),
    }));
  const value = save.isPending ? (save.variables ?? null) : (current.data?.modelId ?? null);
  return (
    <Section title={m.admin_utility_section()}>
      <ListCard>
        <ListRow className="flex-wrap">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{m.admin_utility_label()}</span>
            <span className="text-muted-foreground text-xs">{m.admin_utility_description()}</span>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <ModelSelect
              aria-label={m.admin_utility_label()}
              models={options}
              value={value}
              onChange={(id) => save.mutate(id)}
              placeholder={m.admin_utility_placeholder()}
              disabled={current.isPending}
              className="w-full min-w-0 sm:w-64"
            />
            {value ? (
              <Button variant="ghost" onClick={() => save.mutate(null)}>
                {m.admin_utility_clear()}
              </Button>
            ) : null}
          </div>
        </ListRow>
      </ListCard>
    </Section>
  );
}
