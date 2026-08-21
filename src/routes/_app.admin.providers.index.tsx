import { createFileRoute } from "@tanstack/react-router";
import { modelsQuery, ProvidersPage, providersQuery } from "~/modules/admin/ui/providers-page.tsx";

export const Route = createFileRoute("/_app/admin/providers/")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(providersQuery),
      context.queryClient.ensureQueryData(modelsQuery),
    ]);
  },
  component: ProvidersPage,
});
