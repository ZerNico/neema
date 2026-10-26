import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { ModelRow, PublicProvider } from "~/modules/providers/server/repo.ts";
import { ModelSelect } from "~/modules/providers/ui/model-select.tsx";
import { ListCard, ListRow, Section } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  getReviewModel,
  getUtilityModel,
  updateReviewModel,
  updateUtilityModel,
} from "../server/functions.ts";
import { m } from "~/paraglide/messages.js";

type Models = ReadonlyArray<Pick<ModelRow, "id" | "providerId" | "displayName" | "type">>;
type Providers = ReadonlyArray<Pick<PublicProvider, "id" | "name">>;

/**
 * The model small side tasks run on; empty means each chat's own. It reads
 * every chat's first message, and falls back to the chat's model if it fails.
 */
export function UtilityModelPicker(props: { models: Models; providers: Providers }) {
  return (
    <ModelSettingPicker
      {...props}
      queryKey={["admin", "utility-model"]}
      load={() => getUtilityModel()}
      save={(modelId) => updateUtilityModel({ data: { modelId } })}
      section={m.admin_utility_section()}
      label={m.admin_utility_label()}
      description={m.admin_utility_description()}
      saveError={m.admin_utility_error_save()}
    />
  );
}

/**
 * The model that checks computer calls in chats set to ask when risky; empty means each chat's
 * own. A chosen model that is unavailable makes those chats ask instead.
 */
export function ReviewModelPicker(props: { models: Models; providers: Providers }) {
  return (
    <ModelSettingPicker
      {...props}
      queryKey={["admin", "review-model"]}
      load={() => getReviewModel()}
      save={(modelId) => updateReviewModel({ data: { modelId } })}
      section={m.admin_review_section()}
      label={m.admin_review_label()}
      description={m.admin_review_description()}
      saveError={m.admin_review_error_save()}
    />
  );
}

/** One instance-wide chat model choice, empty meaning each chat's own. */
function ModelSettingPicker({
  models,
  providers,
  queryKey,
  load,
  save: persist,
  section,
  label,
  description,
  saveError,
}: {
  models: Models;
  providers: Providers;
  queryKey: ReadonlyArray<string>;
  load: () => Promise<{ modelId: string | null }>;
  save: (modelId: string | null) => Promise<unknown>;
  section: string;
  label: string;
  description: string;
  saveError: string;
}) {
  const queryClient = useQueryClient();
  const current = useQuery({ queryKey, queryFn: load });
  const save = useMutation({
    mutationFn: persist,
    onError: () => toast.error(saveError),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
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
    <Section title={section}>
      <ListCard>
        <ListRow className="flex-wrap">
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-medium">{label}</span>
            <span className="text-muted-foreground text-xs">{description}</span>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <ModelSelect
              aria-label={label}
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
