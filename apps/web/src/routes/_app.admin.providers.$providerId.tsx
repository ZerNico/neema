import { createFileRoute } from "@tanstack/react-router";
import {
  groupsQuery,
  modelsQuery,
  providersQuery,
  modelAccessQuery,
} from "~/modules/admin/client/queries.ts";
import { ProviderDetailPage } from "~/modules/admin/ui/provider-detail-page.tsx";

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
