import { createFileRoute } from "@tanstack/react-router";
import { KnowledgeAdminPage } from "~/modules/knowledge/ui/knowledge-admin-page.tsx";
import { embeddingConfigurationQuery } from "~/modules/knowledge/client/queries.ts";
import { documentParserToolQuery, scanReadingQuery } from "~/modules/tools/client/queries.ts";
import { projectFileSettingsQuery } from "~/modules/projects/client/queries.ts";

export const Route = createFileRoute("/_app/admin/documents")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(embeddingConfigurationQuery),
      context.queryClient.ensureQueryData(documentParserToolQuery),
      context.queryClient.ensureQueryData(scanReadingQuery),
      context.queryClient.ensureQueryData(projectFileSettingsQuery),
    ]),
  component: KnowledgeAdminPage,
});
