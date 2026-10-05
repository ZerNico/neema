import { createFileRoute } from "@tanstack/react-router";
import { OAuthPage } from "~/modules/auth/ui/oauth-page.tsx";
import { oauthProvidersQuery, signupPolicyQuery } from "~/modules/auth/queries.ts";

export const Route = createFileRoute("/_app/admin/auth")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(oauthProvidersQuery),
      context.queryClient.ensureQueryData(signupPolicyQuery),
    ]),
  component: OAuthPage,
});
