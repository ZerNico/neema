import { MoreVerticalIcon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { authClient } from "~/modules/auth/client.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
import { membershipsQuery } from "./groups-page.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Skeleton } from "~/ui/primitives/skeleton";

export function UsersPage() {
  const queryClient = useQueryClient();
  const session = authClient.useSession();
  // Read-only here; membership is edited on the group detail pages.
  const memberships = useQuery(membershipsQuery);

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const { data, error } = await authClient.admin.listUsers({
        query: { limit: 100, sortBy: "createdAt", sortDirection: "asc" },
      });
      if (error) throw new Error(error.message);
      return data.users;
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const setRole = useMutation({
    mutationFn: async (input: { userId: string; role: "admin" | "user" }) => {
      const { error } = await authClient.admin.setRole(input);
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
  });

  const ban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.banUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
  });

  const unban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.unbanUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
  });

  return (
    <AdminPage title="Users" description="Everyone with an account on this instance.">
      {users.isLoading ? (
        <ListCard>
          {[0, 1, 2].map((i) => (
            <ListRow key={i}>
              <Skeleton className="size-9 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </ListRow>
          ))}
        </ListCard>
      ) : users.isError ? (
        <EmptyState
          icon={UserMultipleIcon}
          title="Could not load users"
          description={users.error.message}
          action={
            <Button size="sm" variant="outline" onClick={() => users.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <ListCard>
          {users.data?.map((user) => {
            const isSelf = user.id === session.data?.user.id;
            const isAdmin = user.role === "admin";
            return (
              <ListRow key={user.id}>
                <Avatar className="size-9">
                  <AvatarFallback>{user.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {user.name}
                    {isSelf ? <span className="text-muted-foreground text-xs">(you)</span> : null}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                </div>
                {(memberships.data ?? [])
                  .filter((membership) => membership.userId === user.id)
                  .map((membership) => (
                    <Badge key={membership.groupId} variant="secondary">
                      {membership.groupName}
                    </Badge>
                  ))}
                {user.banned ? <Badge variant="destructive">banned</Badge> : null}
                <Badge variant={isAdmin ? "default" : "outline"}>
                  {isAdmin ? "admin" : "user"}
                </Badge>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${user.name}`}
                        disabled={isSelf}
                      />
                    }
                  >
                    <HugeiconsIcon icon={MoreVerticalIcon} className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        setRole.mutate({ userId: user.id, role: isAdmin ? "user" : "admin" })
                      }
                    >
                      {isAdmin ? "Remove admin" : "Make admin"}
                    </DropdownMenuItem>
                    {user.banned ? (
                      <DropdownMenuItem onClick={() => unban.mutate(user.id)}>
                        Unban
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem variant="destructive" onClick={() => ban.mutate(user.id)}>
                        Ban user
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ListRow>
            );
          })}
        </ListCard>
      )}
    </AdminPage>
  );
}
