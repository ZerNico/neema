import { createFileRoute } from "@tanstack/react-router";
import { agentQuery } from "~/modules/agents/client/queries.ts";
import { AgentEditorPage } from "~/modules/agents/ui/agent-editor-page.tsx";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";

export const Route = createFileRoute("/_app/agents/$agentId")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
      // Prefetch, not ensure: access loss renders the page's own error state.
      context.queryClient.prefetchQuery({ ...agentQuery(params.agentId), retry: false }),
    ]);
  },
  component: AgentRoute,
});

function AgentRoute() {
  const { agentId } = Route.useParams();
  return <AgentEditorPage agentId={agentId} />;
}
