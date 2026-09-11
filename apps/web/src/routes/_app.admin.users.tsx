import { createFileRoute } from "@tanstack/react-router";
import { membershipsQuery } from "~/modules/admin/ui/groups-page.tsx";
import { UsersPage, usersQuery } from "~/modules/admin/ui/users-page.tsx";
import { pendingAccountsQuery } from "~/modules/auth/ui/pending-accounts.tsx";

export const Route = createFileRoute("/_app/admin/users")({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(usersQuery),
      context.queryClient.ensureQueryData(pendingAccountsQuery),
      // Group badges are decoration on the rows; they must not hold the page.
      context.queryClient.prefetchQuery(membershipsQuery),
    ]);
  },
  component: UsersPage,
});
