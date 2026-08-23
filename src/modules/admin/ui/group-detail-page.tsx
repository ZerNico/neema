import {
  Delete02Icon,
  MoreVerticalIcon,
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
import { useState } from "react";
import {
  addGroupMember,
  deleteGroup,
  listGroupMembers,
  removeGroupMember,
  renameGroup,
} from "../server/functions.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
import { groupsQuery } from "./groups-page.tsx";
import { authClient } from "~/modules/auth/client.ts";
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
import { useConfirm } from "~/ui/confirm.tsx";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

const membersQuery = (groupId: string) =>
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
  // Same key as the users page, so the list is warm when coming from there.
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
  });

  const remove = useMutation({
    mutationFn: (userId: string) => removeGroupMember({ data: { groupId, userId } }),
    onSuccess: invalidate,
  });

  const removeWholeGroup = useMutation({
    mutationFn: () => deleteGroup({ data: { groupId } }),
    onSuccess: async () => {
      await invalidate();
      await navigate({ to: "/admin/groups" });
    },
  });

  if (!group) {
    return (
      <AdminPage title="Group not found" backTo="/admin/groups" backLabel="Groups">
        <p className="text-muted-foreground text-sm">This group does not exist anymore.</p>
      </AdminPage>
    );
  }

  const memberIds = new Set((members.data ?? []).map((m) => m.userId));
  const candidates: PickableUser[] = (users.data ?? [])
    .filter((u) => !memberIds.has(u.id))
    .map((u) => ({ id: u.id, name: u.name, email: u.email }));

  return (
    <AdminPage
      title={group.name}
      backTo="/admin/groups"
      backLabel="Groups"
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="Group actions" />}
          >
            <HugeiconsIcon icon={MoreVerticalIcon} className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit02Icon} className="size-4" />
              Rename group
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={async () => {
                if (
                  await confirm({
                    title: `Delete ${group.name}?`,
                    description:
                      "Members lose access to any model shared only with this group. The users themselves are untouched.",
                    confirmLabel: "Delete group",
                  })
                ) {
                  removeWholeGroup.mutate();
                }
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} className="size-4" />
              Delete group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Members
          </h2>
          <AddMemberPicker
            candidates={candidates}
            disabled={add.isPending}
            onPick={(userId) => add.mutate(userId)}
          />
        </div>
        {(members.data ?? []).length === 0 ? (
          <EmptyState
            icon={UserGroupIcon}
            title="No members yet"
            description="Add users to give them this group's model access."
          />
        ) : (
          <ListCard>
            {(members.data ?? []).map((member) => (
              <ListRow key={member.userId}>
                <Avatar className="size-9">
                  <AvatarFallback>{member.name.slice(0, 2).toUpperCase()}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{member.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${member.name}`}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(member.userId)}
                >
                  <HugeiconsIcon icon={Delete02Icon} className="size-4" />
                </Button>
              </ListRow>
            ))}
          </ListCard>
        )}
      </section>

      <RenameGroupDialog
        groupId={groupId}
        currentName={group.name}
        open={renaming}
        onOpenChange={setRenaming}
      />
    </AdminPage>
  );
}

// Single-select combobox that ACTS instead of selecting: picking a user adds
// them and the field resets, ready for the next addition.
function AddMemberPicker({
  candidates,
  disabled,
  onPick,
}: {
  candidates: PickableUser[];
  disabled: boolean;
  onPick: (userId: string) => void;
}) {
  return (
    <Combobox
      items={candidates}
      value={null}
      disabled={disabled || candidates.length === 0}
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
      <ComboboxTrigger
        render={<Button size="sm" variant="outline" aria-label="Add member" />}
        disabled={disabled || candidates.length === 0}
      >
        Add member
      </ComboboxTrigger>
      <ComboboxContent side="bottom" align="end" className="w-72 min-w-72">
        <ComboboxInput placeholder="Search users…" showTrigger={false} />
        <ComboboxEmpty>
          {candidates.length === 0 ? "Everyone is already a member" : "No users match"}
        </ComboboxEmpty>
        <ComboboxList>
          {(user: PickableUser) => (
            <ComboboxItem key={user.id} value={user}>
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              <span className="text-muted-foreground truncate text-xs">{user.email}</span>
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
  const queryClient = useQueryClient();
  const [name, setName] = useState(currentName);

  const save = useMutation({
    mutationFn: () => renameGroup({ data: { groupId, name: name.trim() } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      onOpenChange(false);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename group</DialogTitle>
          <DialogDescription>Model access and members stay as they are.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor="group-rename">Name</FieldLabel>
            <Input
              id="group-rename"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </Field>
          {save.isError ? (
            <p className="text-destructive text-sm">
              {save.error.message.includes("409")
                ? "A group with this name already exists."
                : "Could not rename the group."}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
