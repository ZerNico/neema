import { createFileRoute } from "@tanstack/react-router";
import { myIntegrationsQuery } from "~/modules/integrations/client/queries.ts";
import { IntegrationsSettingsPage } from "~/modules/integrations/ui/integrations-settings-page.tsx";

export const Route = createFileRoute("/_app/settings/integrations/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(myIntegrationsQuery),
  component: IntegrationsSettingsPage,
});
