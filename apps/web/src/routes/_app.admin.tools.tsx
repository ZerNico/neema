import { createFileRoute } from "@tanstack/react-router";
import { ToolsPage } from "~/modules/tools/ui/tools-page.tsx";
import {
  memoryToolQuery,
  interactiveUiToolQuery,
  mapsToolQuery,
  officeFilesToolQuery,
  urlReaderToolQuery,
  webSearchToolQuery,
  searchProvidersQuery,
} from "~/modules/tools/client/queries.ts";
import { presentationFontsQuery } from "~/modules/presentations/client/queries.ts";

export const Route = createFileRoute("/_app/admin/tools")({
  loader: ({ context }) =>
    Promise.all([
      context.queryClient.ensureQueryData(memoryToolQuery),
      context.queryClient.ensureQueryData(webSearchToolQuery),
      context.queryClient.ensureQueryData(searchProvidersQuery),
      context.queryClient.ensureQueryData(urlReaderToolQuery),
      context.queryClient.ensureQueryData(presentationFontsQuery),
      context.queryClient.ensureQueryData(officeFilesToolQuery),
      context.queryClient.ensureQueryData(interactiveUiToolQuery),
      context.queryClient.ensureQueryData(mapsToolQuery),
    ]),
  component: ToolsPage,
});
