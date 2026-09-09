import { ArrowRight01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { queryOptions, useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { createGroup, listGroupMemberships, listGroups } from "../server/functions.ts";
import { EmptyState, ListCard, ListRow, Page } from "~/ui/page-shell.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "~/ui/primitives/field";
import { Input } from "~/ui/primitives/input";

export const groupsQuery = queryOptions({
  queryKey: ["admin", "groups"],
  queryFn: () => listGroups(),
});

export const membershipsQuery = queryOptions({
  queryKey: ["admin", "group-memberships"],
  queryFn: () => listGroupMemberships(),
});

// The group server functions answer a taken name with a bare 409 Response
// (`Effect.die(new Response(..., { status: 409 }))`), which the server-fn
// client surfaces as an untyped Error carrying the response text. There is no
// tagged field to check on the client, so the sniffing lives here alone.
export const isConflict = (error: unknown): boolean => {
  if (error instanceof Response) return error.status === 409;
  if (error instanceof Error) {
    return error.message.includes("409") || /already taken/i.test(error.message);
  }
  return false;
};

export function GroupsPage() {
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const [adding, setAdding] = useState(false);

  return (
    <Page
      title="Groups"
      description="User groups that private models can be shared with."
      actions={
        <Button size="sm" onClick={() => setAdding(true)}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
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
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
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
              <ListRow interactive>
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                  <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{group.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {group.memberCount === 1 ? "1 member" : `${group.memberCount} members`}
                  </span>
                </div>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="text-muted-foreground size-4 shrink-0"
                />
              </ListRow>
            </Link>
          ))}
        </ListCard>
      )}
      <AddGroupDialog open={adding} onOpenChange={setAdding} />
    </Page>
  );
}

function AddGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const id = useId();
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
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          if (save.isPending) return;
          setName("");
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New group</DialogTitle>
          <DialogDescription>Name it after the people it collects.</DialogDescription>
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
                placeholder="Engineering"
                disabled={save.isPending}
                autoFocus
              />
            </Field>
          </FieldGroup>
          {save.isError ? (
            <FieldError>
              {isConflict(save.error)
                ? "A group with this name already exists."
                : "Could not create the group."}
            </FieldError>
          ) : null}
          <DialogFooter>
            <DialogClose render={<Button variant="outline" disabled={save.isPending} />}>
              Cancel
            </DialogClose>
            <PendingButton type="submit" pending={save.isPending} disabled={!name.trim()}>
              Create group
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
