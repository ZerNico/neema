import { createFileRoute } from "@tanstack/react-router";
import { adminIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { AdminIntegrationsPage } from "~/modules/integrations/ui/admin-integrations-page.tsx";

export const Route = createFileRoute("/_app/admin/integrations")({
  loader: ({ context }) => context.queryClient.ensureQueryData(adminIntegrationsQuery),
  component: AdminIntegrationsPage,
});
