import { ArrowRight01Icon, PlusSignIcon, UserGroupIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import {
  createGroup,
  getDefaultCapabilities,
  getGroupCapabilities,
  updateDefaultCapabilities,
  updateGroupCapabilities,
} from "../server/functions.ts";
import type { Capabilities, Capability } from "~/modules/groups/server/policy.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { EmptyState, ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { Switch } from "~/ui/primitives/switch";
import { SegmentedControl, SegmentedControlItem } from "~/ui/segmented-control.tsx";
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
import { GROUP_NAME_MAX } from "../schema.ts";
import { groupsQuery } from "../client/queries.ts";
import { isConflict } from "./group-conflict.ts";

export function GroupsPage() {
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const [adding, setAdding] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);

  return (
    <Page
      title="Groups"
      description="Groups decide which features their members can use and which private models they can reach."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setEditingDefaults(true)}>
            Default access
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            New group
          </Button>
        </>
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
      <DefaultAccessDialog open={editingDefaults} onOpenChange={setEditingDefaults} />
      <AddGroupDialog open={adding} onOpenChange={setAdding} />
    </Page>
  );
}

type Level = "off" | "use" | "create";

/** Shareable resources: using someone else’s is a separate right from making your own. */
const resourceRows: ReadonlyArray<{
  label: string;
  description: string;
  use: Capability;
  create: Capability;
}> = [
  {
    label: "Agents",
    description: "Use picks agents shared with them. Create also builds and shares their own.",
    use: "agentsUse",
    create: "agentsCreate",
  },
  {
    label: "Knowledge",
    description:
      "Use searches collections shared with them. Create also uploads documents and shares collections.",
    use: "knowledgeUse",
    create: "knowledgeCreate",
  },
  {
    label: "Skills",
    description:
      "Use loads skills shared with them. Create also writes, imports and shares skills.",
    use: "skillsUse",
    create: "skillsCreate",
  },
  {
    label: "Projects",
    description:
      "Use works in projects shared with them. Create also starts projects and invites people.",
    use: "projectsUse",
    create: "projectsCreate",
  },
];

/** Personal features: nothing to share, so there is only on or off. */
const featureGroups: ReadonlyArray<{
  title: string;
  rows: ReadonlyArray<{ label: string; description: string; key: Capability; needs?: Capability }>;
}> = [
  {
    title: "In chat",
    rows: [
      { label: "Web search", description: "Search the web and read pages.", key: "webSearch" },
      {
        label: "Deep research",
        description: "Run longer investigations across many sources.",
        key: "deepResearch",
        needs: "webSearch",
      },
      {
        label: "Attachments",
        description: "Attach files and images to messages.",
        key: "attachments",
      },
      {
        label: "Documents",
        description: "Draft and edit a Markdown document beside the chat.",
        key: "documents",
      },
      { label: "Memory", description: "Remember facts about them across chats.", key: "memory" },
      {
        label: "Custom tools",
        description: "Call tools an admin has added. Only admins can write them.",
        key: "customTools",
      },
    ],
  },
  {
    title: "Automation",
    rows: [
      {
        label: "Schedules",
        description: "Create prompts that run on their own. Each schedule is private to its owner.",
        key: "schedules",
      },
      {
        label: "Work",
        description: "Let the desktop app read and change files on their computer.",
        key: "work",
      },
      {
        label: "Connected apps",
        description: "Let apps like Claude Desktop use their chats, agents and knowledge.",
        key: "mcp",
      },
      {
        label: "API keys",
        description: "Let them make keys for scripts and services that can’t sign in.",
        key: "apiKeys",
      },
    ],
  },
];

const levelOf = (caps: Capabilities, row: (typeof resourceRows)[number]): Level =>
  caps[row.create] ? "create" : caps[row.use] ? "use" : "off";

const withLevel = (
  caps: Capabilities,
  row: (typeof resourceRows)[number],
  level: Level,
): Capabilities => ({ ...caps, [row.use]: level !== "off", [row.create]: level === "create" });

const defaultCapabilitiesQuery = queryOptions({
  queryKey: ["admin", "default-capabilities"],
  queryFn: () => getDefaultCapabilities(),
});

const groupCapabilitiesQuery = (groupId: string) =>
  queryOptions({
    queryKey: ["admin", "group-capabilities", groupId],
    queryFn: () => getGroupCapabilities({ data: { groupId } }),
  });

/** Group settings are complete policies, not overrides of the defaults. */
function CapabilityEditor({ groupId }: { groupId?: string }) {
  const queryClient = useQueryClient();
  const policyQuery = groupId ? groupCapabilitiesQuery(groupId) : defaultCapabilitiesQuery;
  const query = useQuery(policyQuery);
  const mutationKey = ["admin", "save-capabilities", groupId ?? "default"];
  // What the admin last chose, shown until the final queued save settles and
  // the refetch returns, so no refetch in between can show an older policy.
  const [draft, setDraft] = useState<Capabilities | null>(null);
  // Each change shows at once and saves in order. Disabling the controls while
  // a save is in flight made every one of them fade out and back on each click.
  const save = useMutation({
    mutationKey,
    scope: { id: mutationKey.join(":") },
    mutationFn: (capabilities: Capabilities) =>
      groupId
        ? updateGroupCapabilities({ data: { groupId, capabilities } })
        : updateDefaultCapabilities({ data: { capabilities } }),
    onError: (error) => toastError("Could not update feature access.", error),
    onSettled: async () => {
      // A refetch between two queued saves would briefly show the older one.
      if (queryClient.isMutating({ mutationKey }) > 1) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["admin"] }),
        queryClient.invalidateQueries({ queryKey: capabilitiesQuery.queryKey }),
      ]);
      setDraft(null);
    },
  });
  const caps = draft ?? query.data;
  const apply = (next: Capabilities) => {
    setDraft(next);
    save.mutate(next);
  };

  // Settings already on screen stay put if a background refetch fails.
  return caps ? (
    <div className="flex flex-col gap-4">
      <ListCard>
        {resourceRows.map((row) => (
          <ListRow key={row.use}>
            <FeatureText label={row.label} description={row.description} />
            <SegmentedControl
              aria-label={row.label}
              value={[levelOf(caps, row)]}
              multiple={false}
              onValueChange={(value) => {
                const level = value[0] as Level | undefined;
                if (level && level !== levelOf(caps, row)) apply(withLevel(caps, row, level));
              }}
            >
              <SegmentedControlItem value="off">Off</SegmentedControlItem>
              <SegmentedControlItem value="use">Use</SegmentedControlItem>
              <SegmentedControlItem value="create">Create</SegmentedControlItem>
            </SegmentedControl>
          </ListRow>
        ))}
      </ListCard>
      {featureGroups.map((group) => (
        <div key={group.title} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium">{group.title}</h3>
          <ListCard>
            {group.rows.map((row) => {
              const blocked = row.needs !== undefined && !caps[row.needs];
              return (
                <ListRow key={row.key}>
                  <FeatureText
                    label={row.label}
                    description={blocked ? "Needs web search." : row.description}
                  />
                  <Switch
                    aria-label={row.label}
                    checked={caps[row.key] && !blocked}
                    disabled={blocked}
                    onCheckedChange={(enabled) => apply({ ...caps, [row.key]: enabled })}
                  />
                </ListRow>
              );
            })}
          </ListCard>
        </div>
      ))}
    </div>
  ) : query.isError ? (
    <ErrorState title="Could not load feature access" onRetry={() => void query.refetch()} />
  ) : (
    <p className="text-muted-foreground text-sm">Loading feature access…</p>
  );
}

/** A group’s own feature access, shown inline on its detail page. */
export function CapabilitySettings({ groupId }: { groupId: string }) {
  return (
    <Section title="Feature access">
      <CapabilityEditor groupId={groupId} />
    </Section>
  );
}

/** The fallback policy is rarely touched, so it lives behind a button rather than on the page. */
function DefaultAccessDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Default access</DialogTitle>
          <DialogDescription>
            Applies only to people who aren’t in any group. Adding someone to a group replaces this
            with the group’s settings. Changes save right away.
          </DialogDescription>
        </DialogHeader>
        {open ? <CapabilityEditor /> : null}
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FeatureText({ label, description }: { label: string; description: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-xs">{description}</span>
    </div>
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
  const tooLong = name.trim().length > GROUP_NAME_MAX;

  const save = useMutation({
    mutationFn: async () => {
      return createGroup({ data: { name: name.trim() } });
    },
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
          save.reset();
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
            if (name.trim() && !tooLong) save.mutate();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input
                id={`${id}-name`}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (save.isError) save.reset();
                }}
                placeholder="Engineering"
                disabled={save.isPending}
                autoFocus
              />
            </Field>
          </FieldGroup>
          {tooLong ? (
            <FieldError>Group names can’t exceed {GROUP_NAME_MAX} characters.</FieldError>
          ) : save.isError ? (
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
            <PendingButton
              type="submit"
              pending={save.isPending}
              disabled={!name.trim() || tooLong}
            >
              Create group
            </PendingButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
