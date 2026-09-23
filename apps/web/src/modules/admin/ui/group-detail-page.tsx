import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  addGroupMember,
  deleteGroup,
  listGroupMembers,
  removeGroupMember,
  renameGroup,
  updateGroupMemberSharing,
} from "../server/functions.ts";
import { groupsQuery, isConflict } from "./groups-page.tsx";
import { usersQuery } from "./users-page.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";
import { Switch } from "~/ui/primitives/switch";
import { toastError } from "~/ui/error-toast.ts";

export const membersQuery = (groupId: string) =>
  queryOptions({
    queryKey: ["admin", "group-members", groupId],
    queryFn: () => listGroupMembers({ data: { groupId } }),
  });

interface PickableUser {
  id: string;
  name: string;
  email: string;
}

export function GroupDetailPage({ groupId }: { groupId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const members = useQuery(membersQuery(groupId));
  const users = useQuery(usersQuery);
  const [renaming, setRenaming] = useState(false);

  const group = groups.find((g) => g.id === groupId);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
      // Membership decides model visibility, so pickers must refetch too.
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
    ]);

  const add = useMutation({
    mutationFn: (userId: string) => addGroupMember({ data: { groupId, userId } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not add the member.", error),
  });

  const remove = useMutation({
    mutationFn: (userId: string) => removeGroupMember({ data: { groupId, userId } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not remove the member.", error),
  });

  const sharing = useMutation({
    mutationFn: ({ userId, canShare }: { userId: string; canShare: boolean }) =>
      updateGroupMemberSharing({ data: { groupId, userId, canShare } }),
    onSuccess: invalidate,
    onError: (error) => toastError("Could not update sharing permission.", error),
  });

  const removeWholeGroup = useMutation({
    mutationFn: () => deleteGroup({ data: { groupId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/admin/groups" });
    },
    onError: (error) => toastError("Could not delete the group.", error),
  });

  if (!group) {
    return (
      <Page title="Group not found" backTo="/admin/groups" backLabel="Groups">
        <p className="text-muted-foreground text-sm">This group does not exist anymore.</p>
      </Page>
    );
  }

  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates: PickableUser[] = (users.data ?? [])
    .filter((u) => !memberIds.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));

  return (
    <Page
      title={group.name}
      backTo="/admin/groups"
      backLabel="Groups"
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Group actions"
                disabled={sharing.isPending}
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
              Rename group
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete “${group.name}”?`,
                    description:
                      "Members lose access to any model shared only with this group. The users themselves are untouched.",
                    confirmLabel: "Delete group",
                  })
                ) {
                  removeWholeGroup.mutate();
                }
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              Delete group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Section
        title="Members"
        actions={
          <AddMemberPicker
            candidates={candidates}
            pending={add.isPending || sharing.isPending || remove.isPending}
            onPick={(userId) => add.mutate(userId)}
          />
        }
      >
        <p className="text-muted-foreground text-sm">
          Can share into this group allows members to share their own agents and collections.
          Disabling it leaves existing shares intact.
        </p>
        {members.isLoading ? (
          <ListSkeleton media="avatar" label="Loading members" />
        ) : members.isError ? (
          <ErrorState
            title="Could not load members"
            onRetry={() => {
              void members.refetch();
            }}
          />
        ) : (members.data ?? []).length === 0 ? (
          <EmptyState
            icon={UserGroupIcon}
            title="No members yet"
            description="Add users to give them this group’s model access."
          />
        ) : (
          <ListCard>
            {(members.data ?? []).map((member) => (
              <ListRow key={member.userId}>
                <Avatar className="size-9">
                  <AvatarFallback>{member.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{member.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                </div>
                {member.role === "admin" ? (
                  <span className="text-muted-foreground text-xs">Always allowed, admin</span>
                ) : (
                  <label className="flex items-center gap-2 text-xs">
                    Can share into this group<span className="sr-only">for {member.name}</span>
                    <Switch
                      checked={member.canShare}
                      disabled={
                        sharing.isPending ||
                        remove.isPending ||
                        add.isPending ||
                        removeWholeGroup.isPending
                      }
                      aria-busy={
                        (sharing.isPending && sharing.variables?.userId === member.userId) ||
                        undefined
                      }
                      onCheckedChange={(canShare) =>
                        sharing.mutate({ userId: member.userId, canShare })
                      }
                    />
                  </label>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${member.name}`}
                  disabled={remove.isPending || sharing.isPending || removeWholeGroup.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${member.name}?`,
                        description:
                          "They lose access to any model shared only with this group. Their account is untouched.",
                        confirmLabel: "Remove member",
                      })
                    ) {
                      remove.mutate(member.userId);
                    }
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        )}
      </Section>

      <RenameGroupDialog
        groupId={groupId}
        currentName={group.name}
        open={renaming}
        onOpenChange={setRenaming}
      />
    </Page>
  );
}

// Single-select combobox that ACTS instead of selecting: picking a user adds
// them and the field resets, ready for the next addition.
function AddMemberPicker({
  candidates,
  pending,
  onPick,
}: {
  candidates: PickableUser[];
  pending: boolean;
  onPick: (userId: string) => void;
}) {
  const disabled = pending || candidates.length === 0;
  return (
    <Combobox
      items={candidates}
      value={null}
      disabled={disabled}
      onValueChange={(picked: PickableUser | null) => {
        if (picked) onPick(picked.id);
      }}
      itemToStringLabel={(user: PickableUser) => user.name}
      filter={(user: PickableUser, query: string) => {
        const needle = query.trim().toLowerCase();
        return `${user.name} ${user.email}`.toLowerCase().includes(needle);
      }}
      autoHighlight
    >
      <ComboboxTrigger render={<PendingButton size="sm" pending={pending} />} disabled={disabled}>
        Add member
      </ComboboxTrigger>
      <ComboboxContent side="bottom" align="end" className="w-72 min-w-72">
        <ComboboxInput placeholder="Search users…" showTrigger={false} />
        <ComboboxEmpty>
          {candidates.length === 0 ? "Everyone is already a member." : "No users match."}
        </ComboboxEmpty>
        <ComboboxList>
          {(user: PickableUser) => (
            <ComboboxItem key={user.id} value={user}>
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              <span className="text-muted-foreground min-w-0 truncate text-xs">{user.email}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function RenameGroupDialog({
  groupId,
  currentName,
  open,
  onOpenChange,
}: {
  groupId: string;
  currentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);

  const save = useMutation({
    mutationFn: () => renameGroup({ data: { groupId, name: name.trim() } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      setName(name.trim());
      onOpenChange(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (save.isPending) return;
          setName(currentName);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename group</DialogTitle>
          <DialogDescription>Model access and members stay as they are.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={save.isPending}
                autoFocus
              />
            </Field>
          </FieldGroup>
          {save.isError ? (
            <FieldError>
              {isConflict(save.error)
                ? "A group with this name already exists."
                : "Could not rename the group."}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
              Rename
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
