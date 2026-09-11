import { queryOptions } from "@tanstack/react-query";
import { getAgentDraft } from "../server/draft-functions.ts";

export const agentDraftQuery = (draftId: string) =>
  queryOptions({
    queryKey: ["agents", "draft", draftId],
    queryFn: () => getAgentDraft({ data: { draftId } }),
    staleTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
