import { createFileRoute } from "@tanstack/react-router";
import { CustomToolsPage, customToolsQuery } from "~/modules/custom-tools/ui/custom-tools-page.tsx";

export const Route = createFileRoute("/_app/admin/custom-tools/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(customToolsQuery),
  component: CustomToolsPage,
});
