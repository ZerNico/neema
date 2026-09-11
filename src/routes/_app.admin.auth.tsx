import { createFileRoute } from "@tanstack/react-router";
import { OAuthPage, oauthProvidersQuery } from "~/modules/auth/ui/oauth-page.tsx";

export const Route = createFileRoute("/_app/admin/auth")({
  loader: ({ context }) => context.queryClient.ensureQueryData(oauthProvidersQuery),
  component: OAuthPage,
});
