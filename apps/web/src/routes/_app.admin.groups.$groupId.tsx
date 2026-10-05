import { createFileRoute } from "@tanstack/react-router";
import { GroupDetailPage } from "~/modules/admin/ui/group-detail-page.tsx";
import { groupsQuery, membersQuery, usersQuery } from "~/modules/admin/client/queries.ts";

export const Route = createFileRoute("/_app/admin/groups/$groupId")({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(groupsQuery),
      // The members list is the page, not decoration: without it the route
      // renders its own heading over an empty card and fills in a trip later.
      context.queryClient.ensureQueryData(membersQuery(params.groupId)),
      // Only the add-member picker needs these, but it is always mounted.
      context.queryClient.prefetchQuery(usersQuery),
    ]);
  },
  component: GroupDetailRoute,
});

function GroupDetailRoute() {
  const { groupId } = Route.useParams();
  return <GroupDetailPage groupId={groupId} />;
}
