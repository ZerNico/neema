import { createFileRoute } from "@tanstack/react-router";
import { knowledgeCollectionsQuery } from "~/modules/knowledge/client/queries.ts";
import { KnowledgePage } from "~/modules/knowledge/ui/knowledge-page.tsx";

export const Route = createFileRoute("/_app/knowledge/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(knowledgeCollectionsQuery);
  },
  component: KnowledgePage,
});
