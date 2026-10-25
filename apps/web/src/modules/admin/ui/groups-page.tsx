import { NameDialog } from "~/ui/name-dialog.tsx";
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
import { useState } from "react";
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
import { LimitsSection } from "~/modules/limits/ui/limits-editor.tsx";
import { StorageQuotaSection } from "~/modules/limits/ui/storage-quota-section.tsx";
import { GROUP_NAME_MAX } from "../schema.ts";
import { groupsQuery } from "../client/queries.ts";
import { m } from "~/paraglide/messages.js";

export function GroupsPage() {
  const { data: groups } = useSuspenseQuery(groupsQuery);
  const [adding, setAdding] = useState(false);
  const [editingDefaults, setEditingDefaults] = useState(false);

  return (
    <Page
      title={m.admin_groups_title()}
      description={m.admin_groups_description()}
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setEditingDefaults(true)}>
            {m.admin_groups_default_access()}
          </Button>
          <Button size="sm" onClick={() => setAdding(true)}>
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
            {m.admin_groups_new()}
          </Button>
        </>
      }
    >
      {groups.length === 0 ? (
        <EmptyState
          icon={UserGroupIcon}
          title={m.admin_groups_empty_title()}
          description={m.admin_groups_empty_description()}
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
              {m.admin_groups_new()}
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
                    {m.admin_groups_members({ count: group.memberCount })}
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
      <LimitsSection groupId={null} />
      <StorageQuotaSection groupId={null} />
      <DefaultAccessDialog open={editingDefaults} onOpenChange={setEditingDefaults} />
      <AddGroupDialog open={adding} onOpenChange={setAdding} />
    </Page>
  );
}

type Level = "off" | "use" | "create";

/** Shareable resources: using someone else’s is a separate right from making your own. */
const resourceRows: ReadonlyArray<{
  label: () => string;
  description: () => string;
  use: Capability;
  create: Capability;
}> = [
  {
    label: m.admin_groups_resource_agents,
    description: m.admin_groups_resource_agents_description,
    use: "agentsUse",
    create: "agentsCreate",
  },
  {
    label: m.admin_groups_resource_knowledge,
    description: m.admin_groups_resource_knowledge_description,
    use: "knowledgeUse",
    create: "knowledgeCreate",
  },
  {
    label: m.admin_groups_resource_skills,
    description: m.admin_groups_resource_skills_description,
    use: "skillsUse",
    create: "skillsCreate",
  },
  {
    label: m.admin_groups_resource_projects,
    description: m.admin_groups_resource_projects_description,
    use: "projectsUse",
    create: "projectsCreate",
  },
];

/** Personal features: nothing to share, so there is only on or off. */
const featureGroups: ReadonlyArray<{
  title: () => string;
  rows: ReadonlyArray<{
    label: () => string;
    description: () => string;
    key: Capability;
    needs?: Capability;
  }>;
}> = [
  {
    title: m.admin_groups_in_chat,
    rows: [
      {
        label: m.admin_groups_feature_web_search,
        description: m.admin_groups_feature_web_search_description,
        key: "webSearch",
      },
      {
        label: m.admin_groups_feature_research,
        description: m.admin_groups_feature_research_description,
        key: "deepResearch",
        needs: "webSearch",
      },
      {
        label: m.admin_groups_feature_attachments,
        description: m.admin_groups_feature_attachments_description,
        key: "attachments",
      },
      {
        label: m.admin_groups_feature_documents,
        description: m.admin_groups_feature_documents_description,
        key: "documents",
      },
      {
        label: m.admin_groups_feature_memory,
        description: m.admin_groups_feature_memory_description,
        key: "memory",
      },
      {
        label: m.admin_groups_feature_custom_tools,
        description: m.admin_groups_feature_custom_tools_description,
        key: "customTools",
      },
      {
        label: m.admin_groups_feature_mcp_servers,
        description: m.admin_groups_feature_mcp_servers_description,
        key: "mcpServers",
      },
    ],
  },
  {
    title: m.admin_groups_automation,
    rows: [
      {
        label: m.admin_groups_feature_schedules,
        description: m.admin_groups_feature_schedules_description,
        key: "schedules",
      },
      {
        label: m.admin_groups_feature_work,
        description: m.admin_groups_feature_work_description,
        key: "work",
      },
      {
        label: m.admin_groups_feature_connected_apps,
        description: m.admin_groups_feature_connected_apps_description,
        key: "mcp",
      },
      {
        label: m.admin_groups_feature_api_keys,
        description: m.admin_groups_feature_api_keys_description,
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
    onError: (error) => toastError(m.admin_groups_error_capabilities(), error),
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
            <FeatureText label={row.label()} description={row.description()} />
            <SegmentedControl
              aria-label={row.label()}
              value={[levelOf(caps, row)]}
              multiple={false}
              onValueChange={(value) => {
                const level = value[0] as Level | undefined;
                if (level && level !== levelOf(caps, row)) apply(withLevel(caps, row, level));
              }}
            >
              <SegmentedControlItem value="off">{m.admin_groups_level_off()}</SegmentedControlItem>
              <SegmentedControlItem value="use">{m.admin_groups_level_use()}</SegmentedControlItem>
              <SegmentedControlItem value="create">
                {m.admin_groups_level_create()}
              </SegmentedControlItem>
            </SegmentedControl>
          </ListRow>
        ))}
      </ListCard>
      {featureGroups.map((group) => (
        <div key={group.rows[0]?.key} className="flex flex-col gap-2">
          <h3 className="text-muted-foreground text-xs font-medium">{group.title()}</h3>
          <ListCard>
            {group.rows.map((row) => {
              const blocked = row.needs !== undefined && !caps[row.needs];
              return (
                <ListRow key={row.key}>
                  <FeatureText
                    label={row.label()}
                    description={blocked ? m.admin_groups_needs_web_search() : row.description()}
                  />
                  <Switch
                    aria-label={row.label()}
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
    <ErrorState
      title={m.admin_groups_error_load_capabilities()}
      onRetry={() => void query.refetch()}
    />
  ) : (
    <p className="text-muted-foreground text-sm">{m.admin_groups_loading_capabilities()}</p>
  );
}

/** A group’s own feature access, shown inline on its detail page. */
export function CapabilitySettings({ groupId }: { groupId: string }) {
  return (
    <Section title={m.admin_groups_feature_access()}>
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
          <DialogTitle>{m.admin_groups_default_access()}</DialogTitle>
          <DialogDescription>{m.admin_groups_default_access_description()}</DialogDescription>
        </DialogHeader>
        {open ? <CapabilityEditor /> : null}
        <DialogFooter>
          <DialogClose render={<Button />}>{m.common_done()}</DialogClose>
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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <NameDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.admin_groups_new()}
      description={m.admin_groups_new_description()}
      maxLength={GROUP_NAME_MAX}
      placeholder={m.admin_groups_new_placeholder()}
      submitLabel={m.admin_groups_create()}
      failure={m.admin_groups_error_create()}
      onSubmit={async (name) => {
        const group = await createGroup({ data: { name } });
        await queryClient.invalidateQueries({ queryKey: ["admin"] });
        await navigate({ to: "/admin/groups/$groupId", params: { groupId: group.id } });
      }}
    />
  );
}
