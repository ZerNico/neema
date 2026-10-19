import { createFileRoute } from "@tanstack/react-router";
import {
  myIntegrationsQuery,
  personalServersQuery,
} from "~/modules/integrations/client/queries.ts";
import { IntegrationsSettingsPage } from "~/modules/integrations/ui/integrations-settings-page.tsx";

export const Route = createFileRoute("/_app/settings/integrations/")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(myIntegrationsQuery),
      context.queryClient.ensureQueryData(personalServersQuery),
    ]),
  component: IntegrationsSettingsPage,
});
