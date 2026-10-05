import { createFileRoute } from "@tanstack/react-router";
import { ProvidersPage } from "~/modules/admin/ui/providers-page.tsx";
import { modelsQuery, providersQuery } from "~/modules/admin/client/queries.ts";

export const Route = createFileRoute("/_app/admin/providers/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(providersQuery),
      context.queryClient.ensureQueryData(modelsQuery),
    ]);
  },
  component: ProvidersPage,
});
