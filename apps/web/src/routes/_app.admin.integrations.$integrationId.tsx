import { createFileRoute } from "@tanstack/react-router";
import { adminIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { AdminIntegrationPage } from "~/modules/integrations/ui/admin-integration-page.tsx";

export const Route = createFileRoute("/_app/admin/integrations/$integrationId")({
  // Just added: it opens on its settings.
  validateSearch: (search: Record<string, unknown>): { setup?: boolean } =>
    search.setup === true || search.setup === "true" ? { setup: true } : {},
  loader: ({ context }) => context.queryClient.ensureQueryData(adminIntegrationsQuery),
  component: AdminIntegrationRoute,
});

function AdminIntegrationRoute() {
  const { integrationId } = Route.useParams();
  const { setup } = Route.useSearch();
  return (
    <AdminIntegrationPage
      key={integrationId}
      integrationId={integrationId}
      setup={Boolean(setup)}
    />
  );
}
