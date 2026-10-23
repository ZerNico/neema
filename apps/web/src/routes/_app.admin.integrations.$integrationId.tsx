import { createFileRoute } from "@tanstack/react-router";
import { adminIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { AdminIntegrationPage } from "~/modules/integrations/ui/admin-integration-page.tsx";

export const Route = createFileRoute("/_app/admin/integrations/$integrationId")({
  loader: ({ context }) => context.queryClient.ensureQueryData(adminIntegrationsQuery),
  component: AdminIntegrationRoute,
});

function AdminIntegrationRoute() {
  const { integrationId } = Route.useParams();
  return <AdminIntegrationPage key={integrationId} integrationId={integrationId} />;
}
