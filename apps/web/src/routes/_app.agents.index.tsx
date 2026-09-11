import { createFileRoute } from "@tanstack/react-router";
import { agentsQuery } from "~/modules/agents/client/queries.ts";
import { AgentsPage } from "~/modules/agents/ui/agents-page.tsx";

export const Route = createFileRoute("/_app/agents/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(agentsQuery);
  },
  component: AgentsPage,
});
