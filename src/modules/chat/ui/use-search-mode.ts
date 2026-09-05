import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { chatModelsQuery, webSearchAvailabilityQuery } from "../client/queries.ts";
import { resolveChatModel } from "../client/selected-model.ts";

/** Per-message search preference, constrained by the selected model and admin config. */
export function useSearchMode(modelId: string | null) {
  const { data: models } = useSuspenseQuery(chatModelsQuery);
  const { data: availability } = useQuery(webSearchAvailabilityQuery);
  const [preferred, setPreferred] = useState(true);
  const model = resolveChatModel(models, modelId);
  const eligible = (availability?.enabled ?? false) && (model?.capabilities.tools ?? false);

  return {
    enabled: preferred && eligible,
    setEnabled: setPreferred,
    reset: () => setPreferred(true),
  };
}
