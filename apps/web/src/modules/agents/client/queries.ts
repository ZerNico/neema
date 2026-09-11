import { queryOptions } from "@tanstack/react-query";
import { getAgent, getAgentSelection, listAgents } from "../server/functions.ts";

export const agentsQuery = queryOptions({
  queryKey: ["agents", "list"],
  queryFn: () => listAgents(),
  staleTime: 30_000,
});

export const agentSelectionQuery = (agentId: string) =>
  queryOptions({
    queryKey: ["agents", "selection", agentId],
    queryFn: () => getAgentSelection({ data: { agentId } }),
    staleTime: 30_000,
  });

export const agentQuery = (agentId: string) =>
  queryOptions({
    queryKey: ["agents", "detail", agentId],
    queryFn: () => getAgent({ data: { agentId } }),
    staleTime: 30_000,
  });
