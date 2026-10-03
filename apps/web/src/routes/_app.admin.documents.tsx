import { createFileRoute } from "@tanstack/react-router";
import {
  KnowledgeAdminPage,
  embeddingConfigurationQuery,
} from "~/modules/knowledge/ui/knowledge-admin-page.tsx";
import { documentParserToolQuery } from "~/modules/knowledge/ui/knowledge-admin-page.tsx";
import { scanReadingQuery } from "~/modules/pdf/ui/scan-reading-row.tsx";
import { projectFileSettingsQuery } from "~/modules/projects/ui/project-file-settings-section.tsx";

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
