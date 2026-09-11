import { createFileRoute } from "@tanstack/react-router";
import { GroupsPage, groupsQuery } from "~/modules/admin/ui/groups-page.tsx";

export const Route = createFileRoute("/_app/admin/groups/")({
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(groupsQuery);
  },
  component: GroupsPage,
});
