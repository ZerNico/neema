import { NameDialog } from "~/ui/name-dialog.tsx";
import {
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  addGroupMember,
  deleteGroup,
  removeGroupMember,
  renameGroup,
  updateGroupMemberSharing,
} from "../server/functions.ts";
import { CapabilitySettings } from "./groups-page.tsx";
import { groupsQuery, usersQuery, membersQuery } from "../client/queries.ts";
import type { GroupMember, MemberSharing } from "~/modules/groups/server/repo.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { initials } from "~/ui/initials";
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
import { Badge } from "~/ui/primitives/badge";
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
import { GROUP_NAME_MAX } from "../schema.ts";
import { Switch } from "~/ui/primitives/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { toastError } from "~/ui/error-toast.ts";
import { LimitsSection } from "~/modules/limits/ui/limits-editor.tsx";

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
  const [sharingFor, setSharingFor] = useState<GroupMember | null>(null);

  const group = groups.find((g) => g.id === groupId);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin"] }),
      // Membership decides model visibility, so pickers must refetch too.
      queryClient.invalidateQueries({ queryKey: ["chat-models"] }),
      queryClient.invalidateQueries({ queryKey: ["image-models"] }),
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
            render={<Button variant="ghost" size="icon-sm" aria-label="Group actions" />}
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
            pending={add.isPending || remove.isPending}
            onPick={(userId) => add.mutate(userId)}
          />
        }
      >
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
                  <AvatarFallback>{initials(member.name)}</AvatarFallback>
                </Avatar>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{member.name}</span>
                  <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                </div>
                {member.role === "admin" ? (
                  <Tooltip>
                    <TooltipTrigger render={<Badge />}>Admin</TooltipTrigger>
                    <TooltipContent>Admins can share anything into any group.</TooltipContent>
                  </Tooltip>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`Sharing for ${member.name}: ${sharingSummary(member.sharing)}`}
                    disabled={remove.isPending || removeWholeGroup.isPending}
                    onClick={() => setSharingFor(member)}
                  >
                    Sharing: {sharingSummary(member.sharing)}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${member.name}`}
                  disabled={remove.isPending || removeWholeGroup.isPending}
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

      <CapabilitySettings groupId={groupId} />
      <LimitsSection groupId={groupId} />
      <MemberSharingDialog
        groupId={groupId}
        member={sharingFor}
        onClose={() => setSharingFor(null)}
        onSaved={invalidate}
      />
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
const sharingKinds: ReadonlyArray<{ key: keyof MemberSharing; label: string }> = [
  { key: "agents", label: "Agents" },
  { key: "knowledge", label: "Knowledge" },
  { key: "skills", label: "Skills" },
  { key: "projects", label: "Projects" },
];

function sharingSummary(sharing: MemberSharing) {
  const allowed = sharingKinds.filter((kind) => sharing[kind.key]).map((kind) => kind.label);
  return allowed.length === sharingKinds.length
    ? "All"
    : allowed.length
      ? allowed.join(", ")
      : "None";
}

/** Which of their own resources one member may share into this group. */
function MemberSharingDialog({
  groupId,
  member,
  onClose,
  onSaved,
}: {
  groupId: string;
  member: GroupMember | null;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  return (
    <Dialog open={member !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {member ? (
          <MemberSharingForm
            key={member.userId}
            groupId={groupId}
            member={member}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MemberSharingForm({
  groupId,
  member,
  onClose,
  onSaved,
}: {
  groupId: string;
  member: GroupMember;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
}) {
  const [draft, setDraft] = useState(member.sharing);
  const save = useMutation({
    mutationFn: () =>
      updateGroupMemberSharing({ data: { groupId, userId: member.userId, sharing: draft } }),
    onSuccess: async () => {
      await onSaved();
      onClose();
    },
    onError: (error) => toastError("Could not update sharing permission.", error),
  });

  return (
    <form
      className="grid gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>Sharing for {member.name}</DialogTitle>
        <DialogDescription>
          What they may share into this group from their own work. Turning something off leaves what
          they already shared in place.
        </DialogDescription>
      </DialogHeader>
      <ListCard>
        {sharingKinds.map((kind) => (
          <ListRow key={kind.key}>
            <span className="min-w-0 flex-1 text-sm font-medium">{kind.label}</span>
            <Switch
              aria-label={kind.label}
              checked={draft[kind.key]}
              disabled={save.isPending}
              onCheckedChange={(checked) => setDraft({ ...draft, [kind.key]: checked })}
            />
          </ListRow>
        ))}
      </ListCard>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
          Cancel
        </DialogClose>
        <PendingButton type="submit" pending={save.isPending}>
          Save
        </PendingButton>
      </DialogFooter>
    </form>
  );
}

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
  const queryClient = useQueryClient();
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rename group"
      description="Model access and members stay as they are."
      initial={currentName}
      maxLength={GROUP_NAME_MAX}
      submitLabel="Rename"
      failure="Could not rename the group."
      onSubmit={async (name) => {
        await renameGroup({ data: { groupId, name } });
        await queryClient.invalidateQueries({ queryKey: ["admin"] });
      }}
    />
  );
}
