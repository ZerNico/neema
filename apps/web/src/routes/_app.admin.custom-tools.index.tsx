import { createFileRoute } from "@tanstack/react-router";
import { CustomToolsPage } from "~/modules/custom-tools/ui/custom-tools-page.tsx";
import { customToolsQuery } from "~/modules/custom-tools/client/queries.ts";

export const Route = createFileRoute("/_app/admin/custom-tools/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(customToolsQuery),
  component: CustomToolsPage,
});
