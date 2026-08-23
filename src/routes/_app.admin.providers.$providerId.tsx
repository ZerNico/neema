import { createFileRoute } from "@tanstack/react-router";
import { groupsQuery } from "~/modules/admin/ui/groups-page.tsx";
import { modelAccessQuery } from "~/modules/admin/ui/model-access-control.tsx";
import { ProviderDetailPage } from "~/modules/admin/ui/provider-detail-page.tsx";
import { modelsQuery, providersQuery } from "~/modules/admin/ui/providers-page.tsx";

export const Route = createFileRoute("/_app/admin/providers/$providerId")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(providersQuery),
      context.queryClient.ensureQueryData(modelsQuery),
      context.queryClient.ensureQueryData(groupsQuery),
      context.queryClient.ensureQueryData(modelAccessQuery),
    ]);
  },
  component: ProviderDetailRoute,
});

function ProviderDetailRoute() {
  const { providerId } = Route.useParams();
  return <ProviderDetailPage providerId={providerId} />;
}
