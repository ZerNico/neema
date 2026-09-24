import { Calendar03Icon, GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { scheduleQuery } from "~/modules/schedules/client/queries.ts";
import { cadenceLabel, nextFireLabel } from "~/modules/schedules/ui/schedule-labels.ts";
import { HeaderContent } from "~/ui/header-slot.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "~/ui/primitives/hover-card";
import { Badge } from "~/ui/primitives/badge";
import { agentIcon } from "./context-picker.tsx";
import { ConversationTitle, createTitleRevealRegistry } from "./conversation-title.tsx";

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
}: {
  conversationId: string;
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
            <span className="sr-only">Branched from</span>
            <span className="truncate">{branchedFrom.title ?? "New chat…"}</span>
          </Badge>
        ) : null}
      </div>
    </HeaderContent>
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
          {schedule.runsHere ? "Schedule running here" : "Scheduled run of"}
        </span>
        <span className="truncate">{schedule.name}</span>
      </HoverCardTrigger>
      <HoverCardContent align="start" sideOffset={8}>
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="truncate">{schedule.name}</span>
          {detail.data?.paused ? <Badge variant="outline">Paused</Badge> : null}
        </p>
        {facts ? <p className="text-muted-foreground mt-0.5 text-xs">{facts}</p> : null}
        <p className="text-muted-foreground mt-2 text-xs">
          {schedule.runsHere
            ? "Every run of this schedule posts in this chat."
            : "A run of this schedule started this chat."}
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
  const name = agent.name ?? (agent.id === null ? "Deleted agent" : "Agent unavailable");
  return (
    <Badge variant={agent.name === null ? "destructive" : "secondary"} className={tagClassName}>
      <HugeiconsIcon icon={agentIcon(agent.icon ?? "robot")} strokeWidth={2} aria-hidden />
      <span className="sr-only">Agent:</span>
      <span className="truncate">{name}</span>
    </Badge>
  );
}
