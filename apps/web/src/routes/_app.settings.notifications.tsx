import { createFileRoute } from "@tanstack/react-router";
import { NotificationsPage } from "~/modules/settings/ui/notifications-page.tsx";

export const Route = createFileRoute("/_app/settings/notifications")({
  component: NotificationsPage,
});
