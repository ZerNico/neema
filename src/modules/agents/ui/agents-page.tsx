import {
  BubbleChatIcon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlusSignIcon,
  Robot01Icon,
  Share01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { agentsQuery } from "../client/queries.ts";
import { AGENT_LIMITS, type AgentSummary } from "../schema.ts";
import { deleteAgent } from "../server/functions.ts";
import { agentIcon } from "~/modules/chat/ui/context-picker.tsx";
import { relativeAgeLabel } from "~/modules/chat/ui/timestamps.ts";
import { ShareDialog } from "~/modules/sharing/ui/share-dialog.tsx";
import { useConfirm } from "~/ui/confirm.tsx";
import { EmptyState, ErrorState, ListCard, ListRow, Page, Section } from "~/ui/page-shell.tsx";
import { Badge } from "~/ui/primitives/badge";
import { Button, buttonVariants } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";
import { useHydrated } from "~/ui/use-hydrated.ts";

export function AgentsPage() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  // Relative ages come from the visitor's clock, so they wait for hydration.
  const hydrated = useHydrated();
  const agents = useQuery(agentsQuery);
  const [sharing, setSharing] = useState<AgentSummary | null>(null);
  const remove = useMutation({
    mutationFn: (agentId: string) => deleteAgent({ data: { agentId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: () => toast.error("Could not delete the agent."),
  });
  const rows = agents.data ?? [];
  const own = rows.filter((agent) => agent.canEdit);
  const shared = rows.filter((agent) => !agent.canEdit);
  const atLimit = own.length >= AGENT_LIMITS.maxPerUser;
  // Without a description the row still says something true about the agent,
  // the way a collection row falls back to its document count.
  const detail = (agent: AgentSummary) => {
    const age = agent.description || !hydrated ? "" : relativeAgeLabel(agent.updatedAt);
    return [
      agent.description || (age ? `Updated ${age}` : null),
      agent.ownerName ? `Shared by ${agent.ownerName}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
  };
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
              {agent.audience === "instance" ? <Badge variant="outline">Everyone</Badge> : null}
            </span>
            <span className="text-muted-foreground truncate text-xs">{detail(agent)}</span>
          </div>
          <Link
            to="/"
            search={{ agent: agent.id }}
            aria-label={`Start chat with ${agent.name}`}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            <HugeiconsIcon icon={BubbleChatIcon} strokeWidth={2} data-icon="inline-start" />
            Start chat
          </Link>
          {/* Editing, sharing and deleting are the owner's; a recipient only
              ever starts a chat. */}
          {agent.canEdit ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${agent.name}`} />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={<Link to="/agents/$agentId" params={{ agentId: agent.id }} />}
                >
                  <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setSharing(agent)}>
                  <HugeiconsIcon icon={Share01Icon} strokeWidth={2} />
                  Share
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={remove.isPending}
                  onClick={() => {
                    void confirm({
                      title: `Delete “${agent.name}”?`,
                      description:
                        "Chats that used it keep the instructions they ran with; nobody can select it again.",
                      confirmLabel: "Delete agent",
                    }).then((confirmed) => {
                      if (confirmed) remove.mutate(agent.id);
                    });
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </ListRow>
      ))}
    </ListCard>
  );
  const newAgent = (
    <Link
      to="/agents/new"
      className={buttonVariants({ size: "sm" })}
      aria-disabled={atLimit || undefined}
    >
      <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} data-icon="inline-start" />
      New agent
    </Link>
  );
  return (
    <Page
      title="Agents"
      description="Saved chat setups: instructions, a preferred model, tool defaults and attached knowledge."
      rootPath="/"
      rootLabel="Chat"
      actions={atLimit ? undefined : newAgent}
    >
      {agents.isError ? (
        <ErrorState
          title="Could not load agents"
          onRetry={() => {
            void agents.refetch();
          }}
        />
      ) : agents.data === undefined ? null : rows.length === 0 ? (
        <EmptyState
          icon={Robot01Icon}
          title="No agents yet"
          description="Create one with its own instructions and knowledge, then pick it from the composer."
          action={newAgent}
        />
      ) : (
        <>
          {own.length > 0 ? <Section title="Your agents">{list(own)}</Section> : null}
          {shared.length > 0 ? <Section title="Shared with you">{list(shared)}</Section> : null}
        </>
      )}
      {sharing ? (
        <ShareDialog
          key={sharing.id}
          resource={{ kind: "agent", id: sharing.id }}
          title={sharing.name}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(null);
          }}
          href={`/?agent=${encodeURIComponent(sharing.id)}`}
        />
      ) : null}
    </Page>
  );
}
