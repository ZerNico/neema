import { Link01Icon, UserGroupIcon, UserIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { resourceSharingQuery } from "../client/queries.ts";
import type { SharedResource } from "../schema.ts";
import {
  publishResource,
  revokeResourceGroup,
  revokeResourceUser,
  shareResourceWithEmail,
  shareResourceWithGroup,
} from "../server/functions.ts";
import { ErrorState } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/ui/primitives/dialog";
import { Input } from "~/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/ui/primitives/select";
import { Spinner } from "~/ui/primitives/spinner";
import { Switch } from "~/ui/primitives/switch";

const responseText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/**
 * Owner-only sharing for an agent or a collection: exact email, an eligible
 * group, and (for admins) instance-wide publication. Additive read/use grants;
 * nobody but the owner edits. Copying the link grants nothing — the page it
 * opens still checks access.
 */
export function ShareDialog({
  resource,
  title,
  open,
  onOpenChange,
  href,
}: {
  resource: SharedResource;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Path to the resource, for "Copy link". */
  href: string;
}) {
  const queryClient = useQueryClient();
  const grants = useQuery({ ...resourceSharingQuery(resource), enabled: open });
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["sharing", resource.kind, resource.id] });
  const [email, setEmail] = useState("");
  const share = useMutation({
    mutationFn: (value: string) => shareResourceWithEmail({ data: { ...resource, email: value } }),
    onSuccess: async () => {
      setEmail("");
      await invalidate();
    },
    onError: (error) => toast.error(responseText(error, "Could not share with that account.")),
  });
  const shareGroup = useMutation({
    mutationFn: (groupId: string) => shareResourceWithGroup({ data: { ...resource, groupId } }),
    onSuccess: invalidate,
    onError: (error) => toast.error(responseText(error, "Could not share with that group.")),
  });
  const revokeUser = useMutation({
    mutationFn: (userId: string) => revokeResourceUser({ data: { ...resource, userId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not remove access."),
  });
  const revokeGroup = useMutation({
    mutationFn: (groupId: string) => revokeResourceGroup({ data: { ...resource, groupId } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not remove access."),
  });
  const publish = useMutation({
    mutationFn: (audience: "private" | "instance") =>
      publishResource({ data: { ...resource, audience } }),
    onSuccess: invalidate,
    onError: () => toast.error("Could not change who can use this."),
  });
  const pending =
    share.isPending ||
    shareGroup.isPending ||
    revokeUser.isPending ||
    revokeGroup.isPending ||
    publish.isPending;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      toast.success("Link copied. It only works for people who already have access.");
    } catch {
      toast.error("Could not copy the link.");
    }
  };
  const data = grants.data;
  const availableGroups =
    data?.eligibleGroups.filter(
      (group) => !data.groups.some((granted) => granted.groupId === group.id),
    ) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape/overlay/close must not dismiss while a change is in flight.
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share {title}</DialogTitle>
          <DialogDescription>
            {resource.kind === "agent"
              ? "People you share with can chat with this agent. They still need their own access to its model and collections; share those separately."
              : "People you share with can read and use this collection in chats and agents. Only you can change it."}
          </DialogDescription>
        </DialogHeader>
        {grants.isError ? (
          <ErrorState
            title="Could not load sharing"
            onRetry={() => {
              void grants.refetch();
            }}
          />
        ) : !data ? (
          <div className="flex justify-center py-6">
            <Spinner aria-label="Loading sharing" />
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const value = email.trim();
                if (value && !share.isPending) share.mutate(value);
              }}
            >
              <Input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Exact email of an existing account"
                aria-label="Share with email"
                autoComplete="off"
                disabled={pending}
              />
              <Button
                type="submit"
                size="sm"
                disabled={pending || !email.trim()}
                aria-busy={share.isPending || undefined}
              >
                {share.isPending ? <Spinner data-icon="inline-start" aria-hidden /> : null}
                Share
              </Button>
            </form>
            {data.eligibleGroups.length > 0 ? (
              <div className="flex items-center gap-2">
                <Select
                  value={null}
                  onValueChange={(groupId) => {
                    if (typeof groupId === "string" && groupId) shareGroup.mutate(groupId);
                  }}
                  disabled={pending || availableGroups.length === 0}
                >
                  <SelectTrigger aria-label="Share with group" className="flex-1">
                    <SelectValue
                      placeholder={
                        availableGroups.length === 0
                          ? "Every eligible group has access"
                          : "Share with a group…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableGroups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <ul className="divide-border divide-y" aria-label="Current access">
              {data.users.map((user) => (
                <li key={user.userId} className="flex items-center gap-3 py-2">
                  <HugeiconsIcon
                    icon={UserIcon}
                    strokeWidth={2}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{user.name}</span>
                    <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => revokeUser.mutate(user.userId)}
                    disabled={pending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {data.groups.map((group) => (
                <li key={group.groupId} className="flex items-center gap-3 py-2">
                  <HugeiconsIcon
                    icon={UserGroupIcon}
                    strokeWidth={2}
                    className="text-muted-foreground size-4 shrink-0"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                  <Badge variant="outline">group</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => revokeGroup.mutate(group.groupId)}
                    disabled={pending}
                  >
                    Remove
                  </Button>
                </li>
              ))}
              {data.users.length === 0 && data.groups.length === 0 ? (
                <li className="text-muted-foreground py-2 text-sm">
                  {data.audience === "instance"
                    ? "Everyone on this instance has access."
                    : "Only you have access."}
                </li>
              ) : null}
            </ul>
            {data.canPublish ? (
              <label className="flex items-center justify-between gap-3">
                <span className="flex flex-col">
                  <span className="text-sm font-medium">Everyone on this instance</span>
                  <span className="text-muted-foreground text-xs">
                    Any signed-in user can use it. Only you can edit it.
                  </span>
                </span>
                <Switch
                  checked={data.audience === "instance"}
                  onCheckedChange={(checked) => publish.mutate(checked ? "instance" : "private")}
                  disabled={pending}
                  aria-label="Share with everyone on this instance"
                />
              </label>
            ) : data.audience === "instance" ? (
              <p className="text-muted-foreground text-xs">
                Published to everyone on this instance by an administrator.
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => void copyLink()}>
                <HugeiconsIcon icon={Link01Icon} strokeWidth={2} data-icon="inline-start" />
                Copy link
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
