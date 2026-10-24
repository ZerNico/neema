import { createFileRoute } from "@tanstack/react-router";
import { meQuery } from "~/modules/auth/client.ts";
import { signInOptionsQuery } from "~/modules/auth/queries.ts";
import { ProfilePage } from "~/modules/settings/ui/profile-page.tsx";

export const Route = createFileRoute("/_app/settings/profile")({
  // A failed link returns here with Better Auth's code.
  validateSearch: (search: Record<string, unknown>): { error?: string } =>
    typeof search["error"] === "string" ? { error: search["error"].slice(0, 100) } : {},
  // The session is already warm from `_app`'s own check; named here so the
  // page's suspense read has a loader behind it rather than the parent's side effect.
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(meQuery),
      context.queryClient.ensureQueryData(signInOptionsQuery),
    ]),
  component: ProfileRoute,
});

function ProfileRoute() {
  const { error } = Route.useSearch();
  return <ProfilePage linkError={error} />;
}
