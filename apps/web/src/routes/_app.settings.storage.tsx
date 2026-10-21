import { createFileRoute } from "@tanstack/react-router";
import { myStorageQuery } from "~/modules/limits/client/queries.ts";
import { StoragePage } from "~/modules/settings/ui/storage-page.tsx";

export const Route = createFileRoute("/_app/settings/storage")({
  loader: ({ context }) => context.queryClient.ensureQueryData(myStorageQuery),
  component: StoragePage,
});
