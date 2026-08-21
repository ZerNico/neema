import { createFileRoute } from "@tanstack/react-router";
import { ToolsPage, webSearchToolQuery } from "~/modules/tools/ui/tools-page.tsx";

export const Route = createFileRoute("/_app/admin/tools")({
  loader: ({ context }) => context.queryClient.ensureQueryData(webSearchToolQuery),
  component: ToolsPage,
});
