import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { authClient } from "~/modules/auth/client.ts";
import { Badge } from "~/ui/primitives/badge";

export const Route = createFileRoute("/_app/admin/users")({
  component: UsersPanel,
});

function UsersPanel() {
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: { limit: 100, sortBy: "createdAt", sortDirection: "desc" },
      });
      if (error) throw new Error(error.message);
      return data.users;
    },
  });

  if (users.isLoading) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (users.isError) return <p className="text-destructive text-sm">Failed to load users.</p>;

  return (
    <div className="flex flex-col gap-2">
      {users.data?.map((user) => (
        <div
          key={user.id}
          className="flex items-center justify-between rounded-md border px-3 py-2"
        >
          <div className="flex flex-col">
            <span className="text-sm font-medium">{user.name}</span>
            <span className="text-muted-foreground text-xs">{user.email}</span>
          </div>
          <div className="flex items-center gap-2">
            {user.role === "admin" ? <Badge>admin</Badge> : <Badge variant="outline">user</Badge>}
            {user.banned ? <Badge variant="destructive">banned</Badge> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
