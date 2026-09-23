import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { chatModelsQuery } from "../client/queries.ts";
import { resolveChatModel } from "../client/selected-model.ts";
import type { ReasoningEffort } from "~/modules/providers/model-config.ts";

export function useReasoningEffort(modelId: string | null) {
  const { data: models } = useQuery(chatModelsQuery);
  const model = resolveChatModel(models ?? [], modelId);
  const allowed = model?.reasoningEfforts ?? [];
  const key = `${model?.id ?? ""}:${allowed.join(",")}`;
  const [selected, setSelected] = useState<{ key: string; effort: ReasoningEffort | null } | null>(
    null,
  );
  const setEffort = useCallback(
    (effort: ReasoningEffort | null, targetModelId = modelId) => {
      const target = resolveChatModel(models ?? [], targetModelId);
      const targetKey = `${target?.id ?? ""}:${(target?.reasoningEfforts ?? []).join(",")}`;
      setSelected({
        key: targetKey,
        effort: effort && !target?.reasoningEfforts?.includes(effort) ? null : effort,
      });
    },
    [modelId, models],
  );
  return { effort: selected?.key === key ? selected.effort : null, setEffort };
}
