import { createFileRoute } from "@tanstack/react-router";
import { sessionUserQuery } from "~/modules/auth/client.ts";
import { ProfilePage } from "~/modules/settings/ui/profile-page.tsx";

export const Route = createFileRoute("/_app/settings/profile")({
  // Already warm from `_app`'s own check; named here so the page's suspense
  // read has a loader behind it rather than the parent's side effect.
  loader: ({ context }) => context.queryClient.ensureQueryData(sessionUserQuery),
  component: ProfilePage,
});
