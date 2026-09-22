import { createFileRoute } from "@tanstack/react-router";
import { HelpPage } from "~/modules/help/ui/help-page.tsx";

export const Route = createFileRoute("/_app/help")({
  component: HelpPage,
});
