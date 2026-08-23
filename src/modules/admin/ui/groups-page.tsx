import { ArrowRight01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { createGroup, listGroupMemberships, listGroups } from "../server/functions.ts";
import { AdminPage, EmptyState, ListCard, ListRow } from "./admin-shell.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

export const groupsQuery = queryOptions({
  queryKey: ["admin", "groups"],
  queryFn: () => listGroups(),
});

export const membershipsQuery = queryOptions({
  queryKey: ["admin", "group-memberships"],
  queryFn: () => listGroupMemberships(),
});

export function GroupsPage() {
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const [adding, setAdding] = useState(false);

  return (
    <AdminPage
      title="Groups"
      description="User groups that private models can be shared with."
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          New group
        </Button>
      }
    >
      {groups.length === 0 ? (
        <EmptyState
          icon={UserGroupIcon}
          title="No groups yet"
          description="Create a group, add users to it, and share private models with it."
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
              New group
            </Button>
          }
        />
      ) : (
        <ListCard>
          {groups.map((group) => (
            <Link
              key={group.id}
              to="/admin/groups/$groupId"
              params={{ groupId: group.id }}
              className="block"
            >
              <ListRow className="hover:bg-accent/50 transition-colors">
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                  <HugeiconsIcon icon={UserGroupIcon} className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="text-sm font-medium">{group.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {group.memberCount === 1 ? "1 member" : `${group.memberCount} members`}
                  </span>
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  className="text-muted-foreground size-4 shrink-0"
                />
              </ListRow>
            </Link>
          ))}
        </ListCard>
      )}
      <AddGroupDialog open={adding} onOpenChange={setAdding} />
    </AdminPage>
  );
}

function AddGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");

  const save = useMutation({
    mutationFn: () => createGroup({ data: { name: name.trim() } }),
    onSuccess: async (group) => {
      await queryClient.invalidateQueries({ queryKey: ["admin"] });
      onOpenChange(false);
      setName("");
      await navigate({ to: "/admin/groups/$groupId", params: { groupId: group.id } });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Name it after the people it collects.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor="group-name">Name</FieldLabel>
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Engineering"
              autoFocus
            />
          </Field>
          {save.isError ? (
            <p className="text-destructive text-sm">
              {save.error.message.includes("409")
                ? "A group with this name already exists."
                : "Could not create the group."}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
