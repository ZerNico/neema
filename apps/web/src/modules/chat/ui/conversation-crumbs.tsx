import { m } from "~/paraglide/messages.js";
import {
  Archive02Icon,
  ArchiveArrowUpIcon,
  Calendar03Icon,
  Folder01Icon,
  GitBranchIcon,
  IncognitoIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { scheduleQuery } from "~/modules/schedules/client/queries.ts";
import { cadenceLabel, nextFireLabel } from "~/modules/schedules/ui/schedule-labels.ts";
import { HeaderContent } from "~/ui/header-slot.tsx";
import { PendingButton } from "~/ui/pending-button.tsx";
import { keepConversation, setConversationArchived } from "../server/functions.ts";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/primitives/hover-card";
import { Badge } from "~/ui/primitives/badge";
import { agentIcon } from "./agent-icons.ts";
import { ConversationTitle } from "./conversation-title.tsx";
import { createTitleRevealRegistry } from "./title-reveal-registry.ts";
import { ComputerTag, type ChatComputer } from "~/modules/computer/ui/computer-tag.tsx";

interface ScheduleOrigin {
  scheduleId: string;
  name: string;
  runsHere: boolean;
}

// A tag names its kind by icon, so it truncates rather than the title.
const tagClassName = "max-w-48 shrink";

/**
 * The conversation's title in the app header, tagged with its agent and where
 * it came from. Both belong to the whole conversation, so they sit in the
 * chrome rather than above the first message or in the composer.
 */
export function ConversationCrumbs({
  conversationId,
  title,
  schedule,
  branchedFrom,
  agent,
  temporary = false,
  archived = false,
  project,
  computer,
}: {
  conversationId: string;
  /** The chat's computer; shown once the chat has one. */
  computer?: ChatComputer | undefined;
  /** The project this chat works in; a null role means access was lost. */
  project?: { id: string; name: string; role: string | null } | null | undefined;
  /** Hidden from lists and without memory until kept. */
  temporary?: boolean;
  /** Out of the sidebar and lists until unarchived or written in. */
  archived?: boolean;
  title: string | null;
  agent: { id: string | null; name: string | null; icon?: string } | null | undefined;
  schedule: ScheduleOrigin | null | undefined;
  branchedFrom: { conversationId: string; title: string | null } | null | undefined;
}) {
  // Its own registry, not the sidebar's: each surface plays the reveal once.
  const [registry] = useState(createTitleRevealRegistry);
  return (
    <HeaderContent>
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="flex min-w-0 text-sm">
          <ConversationTitle conversationId={conversationId} title={title} registry={registry} />
        </h1>
        {project ? <ProjectTag project={project} /> : null}
        {computer?.machineId ? (
          <ComputerTag conversationId={conversationId} computer={computer} />
        ) : null}
        {agent ? <AgentTag agent={agent} /> : null}
        {schedule ? <ScheduleTag schedule={schedule} /> : null}
        {branchedFrom ? (
          <Badge
            variant="secondary"
            className={tagClassName}
            render={
              <Link
                to="/chat/$conversationId"
                params={{ conversationId: branchedFrom.conversationId }}
              />
            }
          >
            <HugeiconsIcon icon={GitBranchIcon} strokeWidth={2} aria-hidden />
            <span className="sr-only">{m.chat_crumbs_branched_from()}</span>
            <span className="truncate">{branchedFrom.title ?? m.chat_title_pending()}</span>
          </Badge>
        ) : null}
        {temporary ? <TemporaryTag /> : null}
        {archived ? <ArchivedTag /> : null}
      </div>
      {temporary ? <KeepButton conversationId={conversationId} /> : null}
      {archived ? <UnarchiveButton conversationId={conversationId} /> : null}
    </HeaderContent>
  );
}

function TemporaryTag() {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={300}
        closeDelay={100}
        render={<Badge variant="secondary" className={tagClassName} tabIndex={0} />}
      >
        <HugeiconsIcon icon={IncognitoIcon} strokeWidth={2} aria-hidden />
        <span className="truncate">{m.chat_crumbs_temporary()}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <p className="text-muted-foreground text-xs">{m.chat_crumbs_temporary_note()}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

function ArchivedTag() {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={300}
        closeDelay={100}
        render={<Badge variant="secondary" className={tagClassName} tabIndex={0} />}
      >
        <HugeiconsIcon icon={Archive02Icon} strokeWidth={2} aria-hidden />
        <span className="truncate">{m.chat_crumbs_archived()}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <p className="text-muted-foreground text-xs">{m.chat_crumbs_archived_note()}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

function UnarchiveButton({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const unarchive = useMutation({
    mutationFn: () => setConversationArchived({ data: { conversationId, archived: false } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["conversation"] }),
  });
  return (
    <PendingButton
      size="sm"
      variant="outline"
      className="ml-auto shrink-0"
      pending={unarchive.isPending}
      onClick={() => unarchive.mutate()}
    >
      <HugeiconsIcon icon={ArchiveArrowUpIcon} strokeWidth={2} />
      {m.chat_crumbs_unarchive()}
    </PendingButton>
  );
}

function KeepButton({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const keep = useMutation({
    mutationFn: () => keepConversation({ data: { conversationId } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["conversation", conversationId] }),
        queryClient.invalidateQueries({ queryKey: ["conversations"] }),
      ]),
  });
  return (
    <PendingButton
      size="sm"
      variant="outline"
      className="ml-auto shrink-0"
      pending={keep.isPending}
      onClick={() => keep.mutate()}
    >
      {m.chat_crumbs_keep()}
    </PendingButton>
  );
}

function ScheduleTag({ schedule }: { schedule: ScheduleOrigin }) {
  const [open, setOpen] = useState(false);
  // Read on hover only: cadence and next run change on the schedule's page, and
  // the conversation detail should not have to follow them.
  const detail = useQuery({ ...scheduleQuery(schedule.scheduleId), enabled: open });
  const facts = detail.data
    ? [cadenceLabel(detail.data), nextFireLabel(detail.data)].filter(Boolean).join(" · ")
    : null;
  return (
    <HoverCard open={open} onOpenChange={setOpen}>
      <HoverCardTrigger
        delay={300}
        closeDelay={100}
        render={
          <Badge
            variant="secondary"
            className={tagClassName}
            render={
              <Link to="/schedules/$scheduleId" params={{ scheduleId: schedule.scheduleId }} />
            }
          />
        }
      >
        <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} aria-hidden />
        <span className="sr-only">
          {schedule.runsHere ? m.chat_crumbs_schedule_here() : m.chat_crumbs_scheduled_run_of()}
        </span>
        <span className="truncate">{schedule.name}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{schedule.name}</span>
          {detail.data?.paused ? <Badge variant="outline">{m.chat_crumbs_paused()}</Badge> : null}
        </p>
        {facts ? <p className="text-muted-foreground mt-0.5 text-xs">{facts}</p> : null}
        <p className="text-muted-foreground mt-2 text-xs">
          {schedule.runsHere
            ? m.chat_crumbs_schedule_posts_here()
            : m.chat_crumbs_schedule_started()}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Not a link: the agent page is its owner's editor, and a recipient would land
 * on an error. The agent cannot be swapped once the chat exists.
 */
function AgentTag({ agent }: { agent: { id: string | null; name: string | null; icon?: string } }) {
  const name =
    agent.name ??
    (agent.id === null ? m.chat_crumbs_deleted_agent() : m.chat_crumbs_agent_unavailable());
  return (
    <Badge variant={agent.name === null ? "destructive" : "secondary"} className={tagClassName}>
      <HugeiconsIcon icon={agentIcon(agent.icon ?? "robot")} strokeWidth={2} aria-hidden />
      <span className="sr-only">{m.chat_crumbs_agent()}</span>
      <span className="truncate">{name}</span>
    </Badge>
  );
}

function ProjectTag({ project }: { project: { id: string; name: string; role: string | null } }) {
  return (
    <Badge
      variant={project.role ? "secondary" : "destructive"}
      className={tagClassName}
      render={<Link to="/projects/$projectId" params={{ projectId: project.id }} />}
    >
      <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} aria-hidden />
      <span className="sr-only">{m.chat_crumbs_project()}</span>
      <span className="truncate">
        {project.role ? project.name : m.chat_crumbs_project_no_access({ name: project.name })}
      </span>
    </Badge>
  );
}
