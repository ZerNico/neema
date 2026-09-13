import { createFileRoute } from "@tanstack/react-router";
import { desktopSessionsQuery } from "~/modules/auth/client.ts";
import { DevicesPage } from "~/modules/settings/ui/devices-page.tsx";

export const Route = createFileRoute("/_app/settings/devices")({
  loader: ({ context }) => context.queryClient.ensureQueryData(desktopSessionsQuery),
  component: DevicesPage,
});
