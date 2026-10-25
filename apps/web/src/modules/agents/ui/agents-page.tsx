import {
  BubbleChatIcon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  Robot01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AgentAuthoringLaunchMenuItem } from "./agent-authoring-launch.tsx";
import { agentsQuery } from "../client/queries.ts";
import { AGENT_LIMITS, type AgentSummary } from "../schema.ts";
import { agentAuthoringRequest } from "../authoring.ts";
import { deleteAgent } from "../server/functions.ts";
import { agentIcon } from "~/modules/chat/ui/agent-icons.ts";
import { capabilitiesQuery } from "~/modules/groups/client/queries.ts";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { AccessDialog } from "~/modules/sharing/ui/access-dialog.tsx";
import { useConfirm } from "~/ui/confirm-context.ts";
import { CreateSplitButton } from "~/ui/create-split-button.tsx";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  ListSkeleton,
  Page,
  Section,
} from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { toastError } from "~/ui/error-toast.ts";
import { m } from "~/paraglide/messages.js";
import { getLocale } from "~/paraglide/runtime.js";

// Without a description the row still says something true about the agent,
// the way a collection row falls back to its document count.
const detail = (agent: AgentSummary) => {
  const age = agent.description ? "" : relativeAgeLabel(agent.updatedAt, new Date(), getLocale());
  return [
    agent.description || (age ? m.agents_list_updated({ age }) : null),
    agent.ownerName ? m.agents_list_shared_by({ name: agent.ownerName }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

export function AgentsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const agents = useQuery(agentsQuery);
  const { data: capabilities } = useQuery(capabilitiesQuery);
  const [sharing, setSharing] = useState<AgentSummary | null>(null);
  const remove = useMutation({
    mutationFn: (agentId: string) => deleteAgent({ data: { agentId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: (error) => toastError(m.agents_list_delete_failed(), error),
  });
  const rows = agents.data ?? [];
  const own = rows.filter((agent) => agent.canEdit);
  const shared = rows.filter((agent) => !agent.canEdit);
  const atLimit = own.length >= AGENT_LIMITS.maxPerUser;
  const list = (items: AgentSummary[]) => (
    <ListCard>
      {items.map((agent) => (
        <ListRow key={agent.id}>
          <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-2xl">
            <HugeiconsIcon icon={agentIcon(agent.icon)} strokeWidth={2} className="size-4" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="truncate">{agent.name}</span>
              {agent.audience === "instance" ? (
                <Badge variant="outline">{m.agents_list_everyone()}</Badge>
              ) : null}
            </span>
            <span className="text-muted-foreground truncate text-xs">{detail(agent)}</span>
          </div>
          <Link
            to="/"
            search={{ agent: agent.id }}
            aria-label={m.agents_list_start_chat_with({ name: agent.name })}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} data-icon="inline-start" />
            {m.agents_start_chat()}
          </Link>
          {/* Editing, sharing and deleting are the owner's; a recipient only
              ever starts a chat. */}
          {agent.canEdit && capabilities?.agentsCreate ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={m.agents_list_actions_for({ name: agent.name })}
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={<Link to="/agents/$agentId" params={{ agentId: agent.id }} />}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  {m.common_edit()}
                </DropdownMenuItem>
                <AgentAuthoringLaunchMenuItem agentId={agent.id} />
                <DropdownMenuItem onClick={() => setSharing(agent)}>
                  <HugeiconsIcon icon={UserGroupIcon} strokeWidth={2} />
                  {m.agents_access()}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    void confirm({
                      title: m.agents_delete_title({ name: agent.name }),
                      description: m.agents_delete_description(),
                      confirmLabel: m.agents_delete(),
                    }).then((confirmed) => {
                      if (confirmed) remove.mutate(agent.id);
                    });
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {m.common_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </ListRow>
      ))}
    </ListCard>
  );
  // At the limit the control stays put and disabled, the way Knowledge does it:
  // a button that vanishes reads as a missing feature, not a ceiling.
  const newAgent = (
    <CreateSplitButton
      label={m.agents_list_new()}
      disabled={atLimit}
      options={[
        {
          label: m.agents_launch_create_with_chat(),
          icon: BubbleChatIcon,
          link: <Link to="/" search={{}} state={{ chatPrefill: agentAuthoringRequest() }} />,
        },
        {
          label: m.agents_list_set_up_manually(),
          icon: PencilEdit02Icon,
          link: <Link to="/agents/new" />,
        },
      ]}
    />
  );
  return (
    <Page
      title={m.agents_title()}
      rootPath="/"
      rootLabel={m.agents_list_root_label()}
      actions={capabilities?.agentsCreate ? newAgent : null}
    >
      {agents.isError ? (
        <ErrorState
          title={m.agents_list_load_failed()}
          onRetry={() => {
            void agents.refetch();
          }}
        />
      ) : agents.data === undefined ? (
        <ListSkeleton label={m.agents_list_loading()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Robot01Icon}
          title={m.agents_list_empty_title()}
          description={
            capabilities?.agentsCreate ? m.agents_list_empty_create() : m.agents_list_empty_shared()
          }
          action={capabilities?.agentsCreate ? newAgent : null}
        />
      ) : (
        <>
          {own.length > 0 ? <Section title={m.agents_list_yours()}>{list(own)}</Section> : null}
          {shared.length > 0 ? (
            <Section title={m.agents_list_shared_with_you()}>{list(shared)}</Section>
          ) : null}
        </>
      )}
      {sharing ? (
        <AccessDialog
          key={sharing.id}
          resource={{ kind: "agent", id: sharing.id }}
          title={sharing.name}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(null);
          }}
        />
      ) : null}
    </Page>
  );
}
