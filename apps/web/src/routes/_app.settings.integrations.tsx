import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { toast } from "sonner";
import { findIntegration } from "~/modules/integrations/catalog.ts";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationsSettingsPage } from "~/modules/integrations/ui/integrations-settings-page.tsx";

interface ConnectResult {
  integration?: string;
  connected?: string;
  error?: string;
}

export const Route = createFileRoute("/_app/settings/integrations")({
  // The OAuth callback lands here with its outcome in the query string.
  validateSearch: (search: Record<string, unknown>): ConnectResult => ({
    ...(typeof search.integration === "string" ? { integration: search.integration } : {}),
    ...(typeof search.connected === "string" ? { connected: search.connected } : {}),
    ...(typeof search.error === "string" ? { error: search.error.slice(0, 300) } : {}),
  }),
  loader: ({ context }) => context.queryClient.ensureQueryData(myIntegrationsQuery),
  component: IntegrationsRoute,
});

function IntegrationsRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  useEffect(() => {
    if (!search.connected && !search.error) return;
    const name = findIntegration(search.integration ?? "")?.name ?? "The integration";
    if (search.connected) toast.success(`${name} is connected.`);
    else if (search.error) toast.error(search.error);
    void navigate({ to: "/settings/integrations", search: {}, replace: true });
  }, [search, navigate]);
  return <IntegrationsSettingsPage />;
}
