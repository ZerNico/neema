import { createFileRoute } from "@tanstack/react-router";
import { GroupDetailPage } from "~/modules/admin/ui/group-detail-page.tsx";
import { groupsQuery } from "~/modules/admin/ui/groups-page.tsx";

export const Route = createFileRoute("/_app/admin/groups/$groupId")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(groupsQuery);
  },
  component: GroupDetailRoute,
});

function GroupDetailRoute() {
  const { groupId } = Route.useParams();
  return <GroupDetailPage groupId={groupId} />;
}
