import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { authClient, meQuery } from "~/modules/auth/client.ts";
import { useIdentityBoundary } from "~/modules/auth/identity-context.ts";
import { membershipsQuery, usersQuery } from "../client/queries.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { PendingAccounts } from "~/modules/auth/ui/pending-accounts.tsx";
import { authSettingsQuery } from "~/modules/auth/queries.ts";
import { markEmailVerified } from "~/modules/auth/server/signup-functions.ts";
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
import { m } from "~/paraglide/messages.js";

// Group badges shown per row before collapsing into a "+N more" badge.
const MAX_GROUP_BADGES = 2;

export function UsersPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const boundary = useIdentityBoundary();
  // The identity the boundary already pinned for this tree, not a second
  // session read: impersonating swaps it, and both must agree on who "you" is.
  const { data: identity } = useQuery({ ...meQuery, select: (me) => me?.identity ?? null });
  // Read-only here; membership is edited on the group detail pages.
  const memberships = useQuery(membershipsQuery);

  const users = useQuery(usersQuery);
  // Only while verification is required does an unproven address change anything.
  const { data: authSettings } = useQuery(authSettingsQuery);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const impersonate = useMutation({
    mutationFn: async (userId: string) => {
      if (!boundary) throw new Error("Missing identity boundary");
      await boundary.changeIdentity(async () => {
        const { error } = await authClient.admin.impersonateUser({ userId });
        if (error) throw new Error(error.message);
      }, "/");
    },
    onError: (error) => toastError(m.admin_users_error_impersonate(), error),
  });

  const setRole = useMutation({
    mutationFn: async (input: { userId: string; role: "admin" | "user" }) => {
      const { error } = await authClient.admin.setRole(input);
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (error) => toastError(m.admin_users_error_role(), error),
  });

  const ban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.banUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: async () => {
      await invalidate();
      toast.success(m.admin_users_banned_toast());
    },
    onError: (error) => toastError(m.admin_users_error_ban(), error),
  });

  const unban = useMutation({
    mutationFn: async (userId: string) => {
      const { error } = await authClient.admin.unbanUser({ userId });
      if (error) throw new Error(error.message);
    },
    onSuccess: invalidate,
    onError: (error) => toastError(m.admin_users_error_unban(), error),
  });

  const verify = useMutation({
    mutationFn: (userId: string) => markEmailVerified({ data: { userId } }),
    onSuccess: () =>
      Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ["admin", "pending-accounts"] }),
      ]),
    onError: (error) => toastError(m.admin_users_error_verify(), error),
  });

  return (
    <Page title={m.admin_users_title()} description={m.admin_users_description()}>
      <PendingAccounts />
      {users.isLoading ? (
        <ListSkeleton media="avatar" label={m.admin_users_loading()} />
      ) : users.isError ? (
        <ErrorState
          title={m.admin_users_error_load()}
          onRetry={() => {
            void users.refetch();
          }}
        />
      ) : (
        <Section title={m.admin_users_accounts()}>
          <ListCard>
            {users.data?.map((user) => {
              const isSelf = user.id === identity?.userId;
              // The server compares the whole role, so a comma list here would disagree with it.
              const isAdmin = user.role === "admin";
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
                      {isSelf ? (
                        <span className="text-muted-foreground text-xs">{m.admin_users_you()}</span>
                      ) : null}
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
                      {m.admin_users_more_groups({ count: hiddenGroups })}
                    </Badge>
                  ) : null}
                  {authSettings?.verificationRequired && !user.emailVerified ? (
                    <Badge variant="outline">{m.admin_users_unverified()}</Badge>
                  ) : null}
                  {user.banned ? (
                    <Badge variant="destructive">{m.admin_users_banned()}</Badge>
                  ) : null}
                  {/* Only "Admin" carries information: every row here is a user. */}
                  {isAdmin ? <Badge>{m.admin_users_admin()}</Badge> : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={m.admin_users_actions({ name: user.name })}
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
                                title: m.admin_users_impersonate_title({ name: user.name }),
                                description: m.admin_users_impersonate_description({
                                  name: user.name,
                                }),
                                confirmLabel: m.admin_users_impersonate(),
                                destructive: false,
                              })
                            )
                              impersonate.mutate(user.id);
                          }}
                        >
                          {m.admin_users_impersonate()}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        onClick={() =>
                          setRole.mutate({ userId: user.id, role: isAdmin ? "user" : "admin" })
                        }
                      >
                        {isAdmin ? m.admin_users_remove_admin() : m.admin_users_make_admin()}
                      </DropdownMenuItem>
                      {user.emailVerified ? null : (
                        <DropdownMenuItem
                          onClick={async () => {
                            if (
                              await confirm({
                                title: m.admin_users_verify_title({ email: user.email }),
                                description: m.admin_users_verify_description(),
                                confirmLabel: m.admin_users_verify_confirm(),
                                destructive: false,
                              })
                            )
                              verify.mutate(user.id);
                          }}
                        >
                          {m.admin_users_verify()}
                        </DropdownMenuItem>
                      )}
                      {user.banned ? (
                        <DropdownMenuItem onClick={() => unban.mutate(user.id)}>
                          {m.admin_users_unban()}
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={async () => {
                            if (
                              await confirm({
                                title: m.admin_users_ban_title({ name: user.name }),
                                description: m.admin_users_ban_description(),
                                confirmLabel: m.admin_users_ban(),
                              })
                            ) {
                              ban.mutate(user.id);
                            }
                          }}
                        >
                          {m.admin_users_ban()}
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
