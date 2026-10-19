import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  myIntegrationsQuery,
  personalServersQuery,
} from "~/modules/integrations/client/queries.ts";
import { IntegrationSettingsPage } from "~/modules/integrations/ui/integrations-settings-page.tsx";

interface ConnectResult {
  connected?: string;
  error?: string;
}

export const Route = createFileRoute("/_app/settings/integrations/$integrationId")({
  // The OAuth callback lands here with its outcome in the query string.
  validateSearch: (search: Record<string, unknown>): ConnectResult => ({
    ...(typeof search.connected === "string" ? { connected: search.connected } : {}),
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 300) } : {}),
  }),
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(myIntegrationsQuery),
      context.queryClient.ensureQueryData(personalServersQuery),
    ]),
  component: IntegrationRoute,
});

function IntegrationRoute() {
  const { integrationId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { queryClient } = Route.useRouteContext();
  useEffect(() => {
    if (!search.connected && !search.error) return;
    const name =
      queryClient
        .getQueryData(myIntegrationsQuery.queryKey)
        ?.find((integration) => integration.id === integrationId)?.name ?? "The integration";
    if (search.connected) toast.success(`${name} is connected.`);
    else if (search.error) toast.error(search.error);
    void navigate({
      to: "/settings/integrations/$integrationId",
      params: { integrationId },
      search: {},
      replace: true,
    });
  }, [search, navigate, integrationId, queryClient]);
  return <IntegrationSettingsPage integrationId={integrationId} />;
}
