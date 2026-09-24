import { Robot01Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { agentsQuery } from "./queries.ts";

export const useAgentSearch = listSource({
  heading: "Agents",
  icon: Robot01Icon,
  query: agentsQuery,
  allowed: (capabilities) => capabilities.agentsUse,
  text: (agent) => `${agent.description} ${agent.ownerName ?? ""}`,
  detail: (agent) => agent.description || undefined,
  href: (agent) => `/agents/${agent.id}`,
});
