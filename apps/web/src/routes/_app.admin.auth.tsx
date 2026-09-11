import { createFileRoute } from "@tanstack/react-router";
import {
  OAuthPage,
  oauthProvidersQuery,
  signupPolicyQuery,
} from "~/modules/auth/ui/oauth-page.tsx";

export const Route = createFileRoute("/_app/admin/auth")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(oauthProvidersQuery),
      context.queryClient.ensureQueryData(signupPolicyQuery),
    ]),
  component: OAuthPage,
});
