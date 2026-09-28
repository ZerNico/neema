import { createFileRoute } from "@tanstack/react-router";
import {
  memoryToolQuery,
  officeFilesToolQuery,
  ToolsPage,
  urlReaderToolQuery,
  webSearchToolQuery,
} from "~/modules/tools/ui/tools-page.tsx";
import { presentationFontsQuery } from "~/modules/presentations/ui/presentation-fonts.tsx";

export const Route = createFileRoute("/_app/admin/tools")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(memoryToolQuery),
      context.queryClient.ensureQueryData(webSearchToolQuery),
      context.queryClient.ensureQueryData(urlReaderToolQuery),
      context.queryClient.ensureQueryData(presentationFontsQuery),
      context.queryClient.ensureQueryData(officeFilesToolQuery),
    ]),
  component: ToolsPage,
});
