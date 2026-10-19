import { createFileRoute } from "@tanstack/react-router";
import { AppearancePage } from "~/modules/settings/ui/appearance-page.tsx";

export const Route = createFileRoute("/_app/settings/appearance")({
  component: AppearancePage,
});
