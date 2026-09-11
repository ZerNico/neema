import { createFileRoute } from "@tanstack/react-router";
import {
  KnowledgeAdminPage,
  embeddingConfigurationQuery,
} from "~/modules/knowledge/ui/knowledge-admin-page.tsx";
import { documentParserToolQuery } from "~/modules/knowledge/ui/knowledge-admin-page.tsx";

export const Route = createFileRoute("/_app/admin/documents")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(embeddingConfigurationQuery),
      context.queryClient.ensureQueryData(documentParserToolQuery),
    ]),
  component: KnowledgeAdminPage,
});
