import { Cancel01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { shareRecipientsQuery } from "../client/queries.ts";
import { toastError } from "~/ui/error-toast.ts";
import { initials } from "~/ui/initials";
import { ErrorState } from "~/ui/page-shell.tsx";
import { Avatar, AvatarFallback } from "~/ui/primitives/avatar";
import { Button } from "~/ui/primitives/button";
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
import { FieldError } from "~/ui/primitives/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Spinner } from "~/ui/primitives/spinner";
import { m } from "~/paraglide/messages.js";
import { roleLabel } from "~/modules/projects/ui/role-labels.ts";

export type MemberRole = "viewer" | "editor";

export type MemberChange =
  | { action: "addUser"; email: string; role: MemberRole }
  | { action: "setUserRole"; userId: string; role: MemberRole }
  | { action: "removeUser"; userId: string }
  | { action: "addGroup"; groupId: string; role: MemberRole }
  | { action: "removeGroup"; groupId: string };
type AddTarget =
  | { kind: "person"; id: string; name: string; detail: string; email: string }
  | { kind: "group"; id: string; name: string; detail: string };

interface AddSection {
  value: string;
  items: AddTarget[];
}
const roles = (): ReadonlyArray<{ value: MemberRole; label: string }> => [
  { value: "editor", label: roleLabel.editor() },
  { value: "viewer", label: roleLabel.viewer() },
];
const roleText = (role: MemberRole) => roleLabel[role]();
const responseText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
export interface Members {
  users: ReadonlyArray<{ userId: string; name: string; email: string; role: MemberRole }>;
  groups: ReadonlyArray<{ groupId: string; name: string; role: MemberRole }>;
  /** Groups the manager may add; the right is the group's, not membership's. */
  eligibleGroups: ReadonlyArray<{ id: string; name: string }>;
}

/**
 * Who a project or document reaches, each with a role. Whoever manages it adds
 * people and groups; everyone else sees the list. Roles from a person's own
 * row and from their groups add up, so removing one row never claims more
 * than it does. Every change goes through `onChange`, which the owner of the
 * resource maps to its own calls and refreshes.
 */
export function MembersDialog({
  open,
  onOpenChange,
  title,
  description,
  owner,
  members,
  manage,
  onChange,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  owner: { id: string; name: string };
  members: UseQueryResult<Members>;
  manage: boolean;
  onChange: (change: MemberChange) => Promise<unknown>;
  /** Below the list, such as leaving a project. */
  footer?: ReactNode;
}) {
  const ROLES = roles();
  const [role, setRole] = useState<MemberRole>("editor");
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);
  const recipients = useQuery({
    ...shareRecipientsQuery(search),
    enabled: open && manage && picker,
  });
  const add = useMutation({
    mutationFn: (target: AddTarget) =>
      onChange(
        target.kind === "person"
          ? { action: "addUser", email: target.email, role }
          : { action: "addGroup", groupId: target.id, role },
      ),
    onSuccess: () => setAddError(null),
    onError: (error) => setAddError(responseText(error, m.projects_members_add_failed())),
  });
  const changeRole = useMutation({
    mutationFn: (input: { userId: string; role: MemberRole }) =>
      onChange({ action: "setUserRole", ...input }),
    onError: (error) => toastError(m.projects_members_role_failed(), error),
  });
  const removeUser = useMutation({
    mutationFn: (userId: string) => onChange({ action: "removeUser", userId }),
    onError: (error) => toastError(m.projects_members_remove_failed(), error),
  });
  const removeGroup = useMutation({
    mutationFn: (groupId: string) => onChange({ action: "removeGroup", groupId }),
    onError: (error) => toastError(m.projects_members_remove_group_failed(), error),
  });
  const pending =
    add.isPending || changeRole.isPending || removeUser.isPending || removeGroup.isPending;
  const data = members.data;
  const needle = query.trim().toLowerCase();
  const sections: AddSection[] = [
    {
      value: m.projects_members_groups(),
      items: (data?.eligibleGroups ?? [])
        .filter((group) => !data?.groups.some((granted) => granted.groupId === group.id))
        .filter((group) => !needle || group.name.toLowerCase().includes(needle))
        .map((group) => ({
          kind: "group" as const,
          id: group.id,
          name: group.name,
          detail: m.projects_members_group(),
        })),
    },
    {
      value: m.projects_members_people(),
      items: (recipients.data ?? [])
        .filter((person) => person.userId !== owner.id)
        .filter((person) => !data?.users.some((member) => member.userId === person.userId))
        .map((person) => ({
          kind: "person" as const,
          id: person.userId,
          name: person.name,
          detail: person.email,
          email: person.email,
        })),
    },
  ].filter((section) => section.items.length > 0);

  const remove = (label: string, onRemove: () => void) => (
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
  const roleControl = (current: MemberRole, label: string, choose: (next: MemberRole) => void) =>
    manage ? (
      <Select
        items={ROLES}
        value={current}
        onValueChange={(next) => {
          if (next === "editor" || next === "viewer") choose(next);
        }}
        disabled={pending}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ROLES.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <span className="text-muted-foreground shrink-0 text-xs">{roleText(current)}</span>
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">{description}</DialogDescription>
        </DialogHeader>
        {members.isError ? (
          <ErrorState
            title={m.projects_members_load_failed()}
            onRetry={() => {
              void members.refetch();
            }}
          />
        ) : !data ? (
          <div className="flex justify-center py-10">
            <Spinner aria-label={m.projects_members_loading()} />
          </div>
        ) : (
          <div className="flex min-h-0 flex-col gap-5">
            {manage ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
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
                      add.mutate(target);
                    }}
                    onInputValueChange={setQuery}
                    itemToStringLabel={(target: AddTarget) => target.name}
                    isItemEqualToValue={(a: AddTarget, b: AddTarget) =>
                      a.kind === b.kind && a.id === b.id
                    }
                    filter={() => true}
                    autoHighlight
                  >
                    <ComboboxTrigger
                      render={
                        <Button
                          variant="outline"
                          className="min-w-0 flex-1 justify-start"
                          disabled={pending}
                          aria-label={m.projects_members_add()}
                        />
                      }
                    >
                      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
                      {m.projects_members_add()}
                    </ComboboxTrigger>
                    <ComboboxContent align="start" className="w-[var(--anchor-width)] min-w-72">
                      <ComboboxInput
                        placeholder={m.projects_members_search()}
                        showTrigger={false}
                      />
                      <ComboboxEmpty>
                        {recipients.isPending
                          ? m.projects_members_searching()
                          : m.projects_members_no_match()}
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
                  {roleControl(role, m.projects_members_role_for_new(), setRole)}
                </div>
                {addError ? <FieldError>{addError}</FieldError> : null}
              </div>
            ) : null}
            <ul
              className="divide-border min-h-0 divide-y overflow-y-auto"
              aria-label={m.projects_members_title()}
            >
              <li className="flex items-center gap-3 py-2.5">
                <Avatar className="size-9 shrink-0">
                  <AvatarFallback>{initials(owner.name)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate text-sm">{owner.name}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{roleLabel.owner()}</span>
              </li>
              {data.users.map((member) => (
                <li key={member.userId} className="flex items-center gap-3 py-2.5">
                  <Avatar className="size-9 shrink-0">
                    <AvatarFallback>{initials(member.name || member.email)}</AvatarFallback>
                  </Avatar>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{member.name}</span>
                    <span className="text-muted-foreground truncate text-xs">{member.email}</span>
                  </div>
                  {roleControl(
                    member.role,
                    m.projects_members_role_for({ name: member.name }),
                    (next) => changeRole.mutate({ userId: member.userId, role: next }),
                  )}
                  {manage
                    ? remove(m.projects_members_remove({ name: member.name }), () =>
                        removeUser.mutate(member.userId),
                      )
                    : null}
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
                      {m.projects_members_group()}
                    </span>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    {roleText(group.role)}
                  </span>
                  {manage
                    ? remove(m.projects_members_remove({ name: group.name }), () =>
                        removeGroup.mutate(group.groupId),
                      )
                    : null}
                </li>
              ))}
            </ul>
            {footer}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
