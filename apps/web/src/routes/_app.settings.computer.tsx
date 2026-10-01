import { createFileRoute } from "@tanstack/react-router";
import { ComputerPage } from "~/modules/settings/ui/computer-page.tsx";

export const Route = createFileRoute("/_app/settings/computer")({
  component: ComputerPage,
});
