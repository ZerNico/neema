import { createFileRoute } from "@tanstack/react-router";
import { documentLibraryQuery } from "~/modules/documents/client/document-queries.ts";
import { DocumentLibraryPage } from "~/modules/documents/ui/library-page.tsx";

export const Route = createFileRoute("/_app/documents")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(documentLibraryQuery);
  },
  component: DocumentLibraryPage,
});
