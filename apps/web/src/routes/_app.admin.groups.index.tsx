import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage } from "~/modules/admin/ui/groups-page.tsx";
import { groupsQuery } from "~/modules/admin/client/queries.ts";

export const Route = createFileRoute("/_app/admin/groups/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(groupsQuery);
  },
  component: GroupsPage,
});
