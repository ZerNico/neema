import { Robot01Icon } from "@hugeicons/core-free-icons";
import { listSource } from "~/modules/search/registry.ts";
import { m } from "~/paraglide/messages.js";
import { agentsQuery } from "./queries.ts";

export const useAgentSearch = listSource({
  // A getter, so the heading is read in the page's language when shown.
  get heading() {
    return m.agents_title();
  },
  icon: Robot01Icon,
  query: agentsQuery,
  allowed: (capabilities) => capabilities.agentsUse,
  text: (agent) => `${agent.description} ${agent.ownerName ?? ""}`,
  detail: (agent) => agent.description || undefined,
  href: (agent) => `/agents/${agent.id}`,
});
