import { createFileRoute } from "@tanstack/react-router";
import {
  memoryToolQuery,
  ToolsPage,
  urlReaderToolQuery,
  webSearchToolQuery,
} from "~/modules/tools/ui/tools-page.tsx";

export const Route = createFileRoute("/_app/admin/tools")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(memoryToolQuery),
      context.queryClient.ensureQueryData(webSearchToolQuery),
      context.queryClient.ensureQueryData(urlReaderToolQuery),
    ]),
  component: ToolsPage,
});
