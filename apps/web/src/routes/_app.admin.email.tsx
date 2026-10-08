import { createFileRoute } from "@tanstack/react-router";
import { smtpSettingsQuery } from "~/modules/notifications/client/queries.ts";
import { AdminEmailPage } from "~/modules/notifications/ui/admin-email-page.tsx";

export const Route = createFileRoute("/_app/admin/email")({
  loader: ({ context }) => context.queryClient.ensureQueryData(smtpSettingsQuery),
  component: AdminEmailPage,
});
