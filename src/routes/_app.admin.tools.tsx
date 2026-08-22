import { createFileRoute } from "@tanstack/react-router";
import {
  documentParserToolQuery,
  ToolsPage,
  webSearchToolQuery,
} from "~/modules/tools/ui/tools-page.tsx";

export const Route = createFileRoute("/_app/admin/tools")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(webSearchToolQuery),
      context.queryClient.ensureQueryData(documentParserToolQuery),
    ]),
  component: ToolsPage,
});
