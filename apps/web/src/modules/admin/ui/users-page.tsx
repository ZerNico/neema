import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient, sessionIdentityQuery } from "~/modules/auth/client.ts";
import { useIdentityBoundary } from "~/modules/auth/identity-boundary.tsx";
import { membershipsQuery } from "./groups-page.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { PendingAccounts } from "~/modules/auth/ui/pending-accounts.tsx";
import { initials } from "~/ui/initials";
import { ErrorState, ListCard, ListRow, ListSkeleton, Page, Section } from "~/ui/page-shell.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { toastError } from "~/ui/error-toast.ts";

// Group badges shown per row before collapsing into a "+N more" badge.
const MAX_GROUP_BADGES = 2;

export const usersQuery = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: async () => {
    const { data, error } = await authClient.admin.listUsers({
      query: { limit: 100, sortBy: "createdAt", sortDirection: "asc" },
    });
    if (error) throw new Error(error.message);
    return data.users;
  },
});

export function UsersPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const boundary = useIdentityBoundary();
  // The identity the boundary already pinned for this tree, not a second
  // session read: impersonating swaps it, and both must agree on who "you" is.
  const { data: identity } = useQuery(sessionIdentityQuery);
  // Read-only here; membership is edited on the group detail pages.
  const memberships = useQuery(membershipsQuery);

  const users = useQuery(usersQuery);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const impersonate = useMutation({
    mutationFn: async (userId: string) => {
      if (!boundary) throw new Error("Missing identity boundary");
      await boundary.changeIdentity(async () => {
        const { error } = await authClient.admin.impersonateUser({ userId });
        if (error) throw new Error(error.message);
      }, "/");
    },
    onError: (error) => toastError("Could not impersonate the user.", error),
  });

  const setRole = useMutation({
    mutationFn: async (input: { userId: string; role: "admin" | "user" }) => {
      const { error } = await authClient.admin.setRole(input);
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (error) => toastError("Could not change the role.", error),
  });

  const ban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.banUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await invalidate();
      toast.success("User banned.");
    },
    onError: (error) => toastError("Could not ban the user.", error),
  });

  const unban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.unbanUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (error) => toastError("Could not unban the user.", error),
  });

  return (
    <Page title="Users" description="Everyone with an account here.">
      <PendingAccounts />
      {users.isLoading ? (
        <ListSkeleton media="avatar" label="Loading users" />
      ) : users.isError ? (
        <ErrorState
          title="Could not load users"
          onRetry={() => {
            void users.refetch();
          }}
        />
      ) : (
        <Section title="Accounts">
          <ListCard>
            {users.data?.map((user) => {
              const isSelf = user.id === identity?.userId;
              const isAdmin = user.role?.split(",").includes("admin") ?? false;
              const groupNames = (memberships.data ?? [])
                .filter((membership) => membership.userId === user.id)
                .map((membership) => membership.groupName);
              const hiddenGroups = groupNames.length - MAX_GROUP_BADGES;
              return (
                <ListRow key={user.id}>
                  <Avatar className="size-9">
                    <AvatarFallback>{initials(user.name)}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="min-w-0 truncate">{user.name}</span>
                      {isSelf ? <span className="text-muted-foreground text-xs">(you)</span> : null}
                    </span>
                    <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                  </div>
                  {groupNames.slice(0, MAX_GROUP_BADGES).map((groupName) => (
                    <Badge key={groupName} variant="secondary">
                      {groupName}
                    </Badge>
                  ))}
                  {hiddenGroups > 0 ? (
                    <Badge
                      variant="secondary"
                      title={groupNames.slice(MAX_GROUP_BADGES).join(", ")}
                    >
                      +{hiddenGroups} more
                    </Badge>
                  ) : null}
                  {user.banned ? <Badge variant="destructive">Banned</Badge> : null}
                  {/* Only "Admin" carries information: every row here is a user. */}
                  {isAdmin ? <Badge>Admin</Badge> : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${user.name}`}
                          disabled={isSelf || impersonate.isPending}
                        />
                      }
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!isSelf && !isAdmin && !user.banned && !identity?.impersonatedBy && (
                        <DropdownMenuItem
                          disabled={impersonate.isPending}
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Impersonate ${user.name}?`,
                                description: `You will have access to ${user.name}’s private data. All actions, including model requests, run as this user. The session lasts up to one hour.`,
                                confirmLabel: "Impersonate user",
                                destructive: false,
                              })
                            )
                              impersonate.mutate(user.id);
                          }}
                        >
                          Impersonate user
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() =>
                          setRole.mutate({ userId: user.id, role: isAdmin ? "user" : "admin" })
                        }
                      >
                        {isAdmin ? "Remove admin" : "Make admin"}
                      </DropdownMenuItem>
                      {user.banned ? (
                        <DropdownMenuItem onClick={() => unban.mutate(user.id)}>
                          Unban user
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={async () => {
                            if (
                              await confirm({
                                title: `Ban ${user.name}?`,
                                description:
                                  "They are signed out everywhere and cannot sign in again until unbanned. Their data stays.",
                                confirmLabel: "Ban user",
                              })
                            ) {
                              ban.mutate(user.id);
                            }
                          }}
                        >
                          Ban user
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </ListRow>
              );
            })}
          </ListCard>
        </Section>
      )}
    </Page>
  );
}
