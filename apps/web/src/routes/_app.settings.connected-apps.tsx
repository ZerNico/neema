import { createFileRoute } from "@tanstack/react-router";
import { connectedAppsQuery } from "~/modules/mcp-server/client/queries.ts";
import { ConnectedAppsPage } from "~/modules/settings/ui/connected-apps-page.tsx";

export const Route = createFileRoute("/_app/settings/connected-apps")({
  loader: ({ context }) => context.queryClient.ensureQueryData(connectedAppsQuery),
  component: ConnectedAppsPage,
});
