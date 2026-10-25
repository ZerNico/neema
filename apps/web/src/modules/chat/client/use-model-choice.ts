import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { chatModelsQuery } from "./queries.ts";
import { resolveChatModel } from "./selected-model.ts";

/**
 * The model the next message goes to: the person's pick, else what the chat
 * suggests (its own model, a chosen agent's), else the default as it stood
 * when the composer opened, so an admin change does not move a draft. The
 * first of those still offered wins; with none, today's default.
 */
export function useModelChoice(suggested: string | null) {
  const { data: models = [] } = useQuery(chatModelsQuery);
  const [opened] = useState(() => resolveChatModel(models, null)?.id ?? null);
  const [picked, setPicked] = useState<string | null>(null);
  const offered = (id: string | null) => models.find((model) => model.id === id)?.id;
  return {
    modelId:
      offered(picked) ??
      offered(suggested) ??
      offered(opened) ??
      resolveChatModel(models, null)?.id ??
      null,
    /** The explicit pick alone, null while there is none. */
    picked,
    pick: setPicked,
  };
}
