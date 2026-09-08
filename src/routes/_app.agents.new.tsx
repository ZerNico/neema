import { createFileRoute } from "@tanstack/react-router";
import { AgentEditorPage } from "~/modules/agents/ui/agent-editor-page.tsx";
import { chatModelsQuery } from "~/modules/chat/client/queries.ts";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";

export const Route = createFileRoute("/_app/agents/new")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(chatModelsQuery),
      context.queryClient.prefetchQuery(knowledgeCollectionsQuery),
    ]);
  },
  component: () => <AgentEditorPage agentId={null} />,
});
