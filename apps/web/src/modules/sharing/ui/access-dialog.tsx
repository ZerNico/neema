import { Cancel01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { resourceSharingQuery, shareRecipientsQuery } from "../client/queries.ts";
import type { SharedResource } from "../schema.ts";
import {
  publishResource,
  revokeResourceGroup,
  revokeResourceUser,
  shareResourceWithEmail,
  shareResourceWithGroup,
} from "../server/functions.ts";
import { useConfirm } from "~/ui/confirm.tsx";
import { ErrorState } from "~/ui/page-shell.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
import { FieldError } from "~/ui/primitives/field";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from "~/ui/primitives/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Separator } from "~/ui/primitives/separator";
import { Spinner } from "~/ui/primitives/spinner";

interface EligibleGroup {
  id: string;
  name: string;
}

/** One row of the picker: an account to grant by email, or an eligible group. */
type AddTarget =
  | { kind: "person"; id: string; name: string; detail: string; email: string }
  | { kind: "group"; id: string; name: string; detail: string };
interface AddSection {
  value: string;
  items: AddTarget[];
}

const AUDIENCES = [
  { value: "private", label: "Only people and groups you add" },
  { value: "instance", label: "Everyone signed in" },
];

const responseText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

// Two words at most: "Alex Morgan" → AM, "support@acme.io" → S.
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("") || "?";

/**
 * Owner-only access management for an agent or a collection. Every grant is the
 * same permission (use, never edit), so rows carry a plain "Can use" label
 * rather than a role picker. Grants are additive: a person keeps access that
 * comes from a group or from everyone signed in, which is why removing one row
 * never claims more than it does.
 */
export function AccessDialog({
  resource,
  title,
  open,
  onOpenChange,
}: {
  resource: SharedResource;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const grants = useQuery({ ...resourceSharingQuery(resource), enabled: open });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["sharing", resource.kind, resource.id] });
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  // Typing hits the directory endpoint, so let the field settle first.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  // A confirmation is a modal await, so it counts as work in flight: nothing
  // else may mutate (or dismiss the dialog) while one is open.
  const [confirming, setConfirming] = useState(false);

  const share = useMutation({
    mutationFn: (value: string) => shareResourceWithEmail({ data: { ...resource, email: value } }),
    onSuccess: async () => {
      setAddError(null);
      await invalidate();
    },
    onError: (cause) =>
      setAddError(responseText(cause, "Could not give access to that email address.")),
  });
  const shareGroup = useMutation({
    mutationFn: (group: EligibleGroup) =>
      shareResourceWithGroup({ data: { ...resource, groupId: group.id } }),
    onSuccess: async (_result, group) => {
      setAddError(null);
      await invalidate();
      toast.success(`${group.name} can use this.`);
    },
    onError: (cause) => setAddError(responseText(cause, "Could not give that group access.")),
  });
  const revokeUser = useMutation({
    mutationFn: (user: { userId: string; name: string }) =>
      revokeResourceUser({ data: { ...resource, userId: user.userId } }),
    onSuccess: async (_result, user) => {
      await invalidate();
      // Grants are additive, so this row was not necessarily their only way in.
      // Say so here rather than parking a permanent caveat above the list.
      const other = otherAccess();
      toast.success(
        other
          ? `Removed ${user.name}. They can still use this through ${other}.`
          : `Removed ${user.name}.`,
      );
    },
    onError: () => toast.error("Could not remove access."),
  });
  const revokeGroup = useMutation({
    mutationFn: (group: { groupId: string }) =>
      revokeResourceGroup({ data: { ...resource, groupId: group.groupId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not remove access."),
  });
  const publish = useMutation({
    mutationFn: (audience: "private" | "instance") =>
      publishResource({ data: { ...resource, audience } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not change general access."),
  });
  const pending =
    confirming ||
    share.isPending ||
    shareGroup.isPending ||
    revokeUser.isPending ||
    revokeGroup.isPending ||
    publish.isPending;

  const data = grants.data;
  // Named for the message shown when a direct grant is removed: null when this
  // row really was the person's only access.
  const otherAccess = () => {
    if (!data) return null;
    if (data.audience === "instance") return "everyone signed in";
    if (data.groups.length > 0) return "a group";
    return null;
  };
  const recipients = useQuery({ ...shareRecipientsQuery(search), enabled: open && picker });
  const availableGroups =
    data?.eligibleGroups.filter(
      (group) => !data.groups.some((granted) => granted.groupId === group.id),
    ) ?? [];
  const granted = new Set(data?.users.map((user) => user.userId));
  const people: AddTarget[] = (recipients.data ?? [])
    .filter((person) => !granted.has(person.userId))
    .map((person) => ({
      kind: "person",
      id: person.userId,
      name: person.name,
      detail: person.email,
      email: person.email,
    }));
  const groupMatches: AddTarget[] = availableGroups
    .filter((group) => !search || group.name.toLowerCase().includes(search.toLowerCase()))
    .map((group) => ({ kind: "group", id: group.id, name: group.name, detail: "Group" }));
  // Groups first: granting one covers several people at once, so it is the
  // choice worth seeing before scrolling a directory.
  const sections: AddSection[] = [
    groupMatches.length > 0 ? { value: "Groups", items: groupMatches } : null,
    people.length > 0 ? { value: "People", items: people } : null,
  ].filter((section) => section !== null);

  // Only the broadening direction has a consequence worth interrupting for.
  const changeAudience = async (next: string | null) => {
    if (pending || !data || next === data.audience) return;
    if (next !== "private" && next !== "instance") return;
    if (next === "private") {
      publish.mutate("private");
      return;
    }
    setConfirming(true);
    const accepted = await confirm({
      title: "Let everyone signed in use this?",
      description:
        "Anyone with an account on this app will be able to use it. They still cannot edit it, and it does not become public on the internet.",
      confirmLabel: "Give access",
      destructive: false,
    });
    setConfirming(false);
    if (accepted) publish.mutate("instance");
  };

  const removeButton = (label: string, onRemove: () => void) => (
    <Button
      size="icon-sm"
      variant="ghost"
      className="text-muted-foreground hover:text-foreground"
      aria-label={label}
      disabled={pending}
      onClick={onRemove}
    >
      <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
    </Button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape/overlay/close must not dismiss while a change is in flight.
        if (!next && pending) return;
        if (!next) {
          setQuery("");
          setAddError(null);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[min(40rem,calc(100dvh-2rem))] min-h-0 flex-col">
        <DialogHeader>
          <DialogTitle>Access</DialogTitle>
          <DialogDescription className="break-words">{title}</DialogDescription>
        </DialogHeader>
        {grants.isError ? (
          <ErrorState
            title="Could not load access"
            onRetry={() => {
              void grants.refetch();
            }}
          />
        ) : !data ? (
          <div className="flex justify-center py-10">
            <Spinner aria-label="Loading access" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Combobox
                items={sections}
                value={null}
                open={picker}
                onOpenChange={setPicker}
                disabled={pending}
                onValueChange={(target: AddTarget | null) => {
                  if (!target) return;
                  setAddError(null);
                  setPicker(false);
                  if (target.kind === "person") share.mutate(target.email);
                  else shareGroup.mutate({ id: target.id, name: target.name });
                }}
                onInputValueChange={setQuery}
                itemToStringLabel={(target: AddTarget) => target.name}
                isItemEqualToValue={(a: AddTarget, b: AddTarget) =>
                  a.kind === b.kind && a.id === b.id
                }
                // People come back already matched by the server, and groups are
                // matched beside them; filtering again here would drop hits whose
                // match was in an email rather than the visible label.
                filter={() => true}
                autoHighlight
              >
                <ComboboxTrigger
                  render={
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      disabled={pending}
                      // role=combobox takes its name from the author, not from
                      // the trigger's own text.
                      aria-label="Add people or groups"
                    />
                  }
                >
                  <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                  Add people or groups
                </ComboboxTrigger>
                <ComboboxContent align="start" className="w-[var(--anchor-width)] min-w-72">
                  <ComboboxInput placeholder="Search by name or email…" showTrigger={false} />
                  <ComboboxEmpty>
                    {recipients.isPending ? "Searching…" : "No people or groups match"}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(section: AddSection) => (
                      <ComboboxGroup key={section.value} items={section.items}>
                        <ComboboxLabel>{section.value}</ComboboxLabel>
                        <ComboboxCollection>
                          {(target: AddTarget) => (
                            <ComboboxItem key={`${target.kind}:${target.id}`} value={target}>
                              <span className="flex min-w-0 flex-col">
                                <span className="truncate">{target.name}</span>
                                <span className="text-muted-foreground truncate text-xs">
                                  {target.detail}
                                </span>
                              </span>
                            </ComboboxItem>
                          )}
                        </ComboboxCollection>
                      </ComboboxGroup>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {addError ? <FieldError>{addError}</FieldError> : null}
            </div>

            <div className="flex min-h-0 flex-col gap-2">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                People with access
              </h2>
              {data.users.length === 0 && data.groups.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Nobody else yet. Only you can use this.
                </p>
              ) : null}
              <ul className="divide-border min-h-0 divide-y overflow-y-auto" aria-label="Access">
                {data.users.map((user) => (
                  <li key={user.userId} className="flex items-center gap-3 py-2.5">
                    <Avatar className="size-9 shrink-0">
                      <AvatarFallback>{initials(user.name || user.email)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{user.name}</span>
                      <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">Can use</span>
                    {removeButton(`Remove access for ${user.name}`, () => revokeUser.mutate(user))}
                  </li>
                ))}
                {data.groups.map((group) => (
                  <li key={group.groupId} className="flex items-center gap-3 py-2.5">
                    <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                      <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{group.name}</span>
                      <span className="text-muted-foreground text-xs">Group</span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">Can use</span>
                    {removeButton(`Remove access for ${group.name}`, () =>
                      revokeGroup.mutate(group),
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                General access
              </h2>
              {data.canPublish ? (
                <Select
                  items={AUDIENCES}
                  value={data.audience}
                  onValueChange={(next) => void changeAudience(next)}
                  disabled={pending}
                >
                  <SelectTrigger aria-label="General access" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIENCES.map((audience) => (
                      <SelectItem key={audience.value} value={audience.value}>
                        {audience.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm">
                  {data.audience === "instance"
                    ? "Everyone signed in"
                    : "Only people and groups you add"}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {data.audience === "instance"
                  ? "Anyone with an account here can use it. It is not public on the internet."
                  : resource.kind === "agent"
                    ? "People you add can use this agent, not edit it. They need their own access to its model and collections."
                    : "People you add can use this collection in chats, not edit it."}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
