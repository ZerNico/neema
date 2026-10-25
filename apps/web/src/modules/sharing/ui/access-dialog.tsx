import { Cancel01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { resourceSharingQuery, shareRecipientsQuery } from "../client/queries.ts";
import type { SharedResource } from "../schema.ts";
import { changeSharing } from "../server/functions.ts";
import { useConfirm } from "~/ui/confirm-context.ts";
import { initials } from "~/ui/initials";
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
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";

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
  label: string;
  items: AddTarget[];
}

const audiences = () => [
  { value: "private", label: m.sharing_audience_private() },
  { value: "instance", label: m.sharing_audience_instance() },
];

const responseText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

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
    mutationFn: (value: string) =>
      changeSharing({ data: { ...resource, change: { action: "email", email: value } } }),
    onSuccess: async () => {
      setAddError(null);
      await invalidate();
    },
    onError: (cause) => setAddError(responseText(cause, m.sharing_error_add_email())),
  });
  const shareGroup = useMutation({
    mutationFn: (group: EligibleGroup) =>
      changeSharing({ data: { ...resource, change: { action: "group", groupId: group.id } } }),
    onSuccess: async (_result, group) => {
      setAddError(null);
      await invalidate();
      toast.success(m.sharing_toast_group_added({ name: group.name }));
    },
    onError: (cause) => setAddError(responseText(cause, m.sharing_error_add_group())),
  });
  const revokeUser = useMutation({
    mutationFn: (user: { userId: string; name: string }) =>
      changeSharing({
        data: { ...resource, change: { action: "revokeUser", userId: user.userId } },
      }),
    onSuccess: async (_result, user) => {
      await invalidate();
      // Grants are additive, so this row was not necessarily their only way in.
      // Say so here rather than parking a permanent caveat above the list.
      const other = otherAccess();
      const name = { name: user.name };
      toast.success(
        other === "instance"
          ? m.sharing_toast_removed_everyone(name)
          : other === "group"
            ? m.sharing_toast_removed_group(name)
            : m.sharing_toast_removed(name),
      );
    },
    onError: (error) => toastError(m.sharing_error_remove(), error),
  });
  const revokeGroup = useMutation({
    mutationFn: (group: { groupId: string }) =>
      changeSharing({
        data: { ...resource, change: { action: "revokeGroup", groupId: group.groupId } },
      }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.sharing_error_remove(), error),
  });
  const publish = useMutation({
    mutationFn: (audience: "private" | "instance") =>
      changeSharing({ data: { ...resource, change: { action: "publish", audience } } }),
    onSuccess: invalidate,
    onError: (error) => toastError(m.sharing_error_publish(), error),
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
    if (data.audience === "instance") return "instance";
    if (data.groups.length > 0) return "group";
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
    .map((group) => ({
      kind: "group",
      id: group.id,
      name: group.name,
      detail: m.sharing_group_detail(),
    }));
  // Groups first: granting one covers several people at once, so it is the
  // choice worth seeing before scrolling a directory.
  const sections: AddSection[] = [
    groupMatches.length > 0
      ? { value: "groups", label: m.sharing_section_groups(), items: groupMatches }
      : null,
    people.length > 0
      ? { value: "people", label: m.sharing_section_people(), items: people }
      : null,
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
      title: m.sharing_confirm_publish_title(),
      description: m.sharing_confirm_publish_description(),
      confirmLabel: m.sharing_confirm_publish_action(),
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
      <DialogContent
        scrollable={false}
        className="flex max-h-[min(40rem,calc(var(--dialog-viewport-height,100dvh)-2rem))] min-h-0 flex-col"
      >
        <DialogHeader>
          <DialogTitle>{m.sharing_title()}</DialogTitle>
          <DialogDescription className="break-words">{title}</DialogDescription>
        </DialogHeader>
        {grants.isError ? (
          <ErrorState
            title={m.sharing_error_load()}
            onRetry={() => {
              void grants.refetch();
            }}
          />
        ) : !data ? (
          <div className="flex justify-center py-10">
            <Spinner aria-label={m.sharing_loading()} />
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
                      aria-label={m.sharing_add()}
                    />
                  }
                >
                  <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                  {m.sharing_add()}
                </ComboboxTrigger>
                <ComboboxContent align="start" className="w-[var(--anchor-width)] min-w-72">
                  <ComboboxInput placeholder={m.sharing_add_placeholder()} showTrigger={false} />
                  <ComboboxEmpty>
                    {recipients.isPending ? m.sharing_add_searching() : m.sharing_add_empty()}
                  </ComboboxEmpty>
                  <ComboboxList>
                    {(section: AddSection) => (
                      <ComboboxGroup key={section.value} items={section.items}>
                        <ComboboxLabel>{section.label}</ComboboxLabel>
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
                {m.sharing_people_heading()}
              </h2>
              {data.users.length === 0 && data.groups.length === 0 ? (
                <p className="text-muted-foreground text-sm">{m.sharing_people_empty()}</p>
              ) : null}
              <ul
                className="divide-border min-h-0 divide-y overflow-y-auto"
                aria-label={m.sharing_people_list()}
              >
                {data.users.map((user) => (
                  <li key={user.userId} className="flex items-center gap-3 py-2.5">
                    <Avatar className="size-9 shrink-0">
                      <AvatarFallback>{initials(user.name || user.email)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{user.name}</span>
                      <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {m.sharing_can_use()}
                    </span>
                    {removeButton(m.sharing_remove_access({ name: user.name }), () =>
                      revokeUser.mutate(user),
                    )}
                  </li>
                ))}
                {data.groups.map((group) => (
                  <li key={group.groupId} className="flex items-center gap-3 py-2.5">
                    <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
                      <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} className="size-4" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{group.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {m.sharing_group_detail()}
                      </span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {m.sharing_can_use()}
                    </span>
                    {removeButton(m.sharing_remove_access({ name: group.name }), () =>
                      revokeGroup.mutate(group),
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <Separator />

            <div className="flex flex-col gap-2">
              <h2 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {m.sharing_general_heading()}
              </h2>
              {data.canPublish ? (
                <Select
                  items={audiences()}
                  value={data.audience}
                  onValueChange={(next) => void changeAudience(next)}
                  disabled={pending}
                >
                  <SelectTrigger aria-label={m.sharing_general_heading()} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {audiences().map((audience) => (
                      <SelectItem key={audience.value} value={audience.value}>
                        {audience.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-sm">
                  {data.audience === "instance"
                    ? m.sharing_audience_instance()
                    : m.sharing_audience_private()}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {data.audience === "instance"
                  ? m.sharing_hint_instance()
                  : resource.kind === "agent"
                    ? m.sharing_hint_agent()
                    : resource.kind === "customTool"
                      ? m.sharing_hint_custom_tool()
                      : resource.kind === "integration"
                        ? m.sharing_hint_integration()
                        : resource.kind === "skill"
                          ? m.sharing_hint_skill()
                          : m.sharing_hint_collection()}
              </p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
