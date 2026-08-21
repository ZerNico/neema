import { createFileRoute } from "@tanstack/react-router";
import { ProfilePage } from "~/modules/settings/ui/profile-page.tsx";

export const Route = createFileRoute("/_app/settings/profile")({
  component: ProfilePage,
});
