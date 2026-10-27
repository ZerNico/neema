import { getLocale } from "~/paraglide/runtime.js";
import { m } from "~/paraglide/messages.js";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { IntegrationToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { ActivityChevron, ActivityFace, ActivityNote } from "~/modules/chat/ui/activity-face.tsx";
import { activityRowClassName } from "~/modules/chat/ui/activity-row.ts";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { cn } from "~/ui/utils";
import { pendingIntegrationCallsQuery } from "../client/queries.ts";
import {
  approvalConsequence,
  type IntegrationDecision,
  type PendingIntegrationCall,
} from "../schema.ts";
import { IntegrationLogo } from "./integration-logo.tsx";
import { useIntegrationDirectory } from "../client/directory.ts";
import { toolText } from "../tool-text.ts";
import {
  useDecideIntegrationCall,
  useIntegrationCallNames,
} from "../client/use-integration-call.ts";

/**
 * One call into a connected service. While it runs it may be parked on the
 * person's decision, which is asked above the composer from the server's list
 * of waiting calls, so a reload or another tab shows the same question.
 */
export function IntegrationActivityBlock({ activity }: { activity: IntegrationToolActivity }) {
  const running = activity.status === "running";
  const pending = useQuery({ ...pendingIntegrationCallsQuery, enabled: running });
  const waiting = running
    ? (pending.data?.find((call) => call.callId === activity.callId) ?? null)
    : null;
  const [open, setOpen] = useState(false);
  const directory = useIntegrationDirectory();
  const name = directory.name(activity.integrationId);
  const toolLabel = toolText(directory.find(activity.integrationId)?.kind, {
    name: activity.tool,
    label: activity.label,
  }).label;
  // A server's own tools have no summary of their own, only their arguments:
  // those are for whoever wants them, so the row says what the call was.
  const argumentsOnly = directory.find(activity.integrationId)?.manifest.toolSource === "listed";
  const shownSummary = argumentsOnly ? null : activity.summary;
  const hiddenSummary = argumentsOnly ? activity.summary : null;
  const failed = activity.status === "error";
  const asking = waiting?.kind === "elicitation" && waiting.prompt ? waiting : null;
  const label = asking
    ? m.integrations_activity_waiting_answer({ label: toolLabel })
    : waiting
      ? m.integrations_activity_waiting_approval({ label: toolLabel })
      : activity.refused
        ? m.integrations_activity_refused({ label: toolLabel })
        : failed
          ? m.integrations_activity_failed({ label: toolLabel })
          : toolLabel;
  const detail = [
    activity.account,
    shownSummary,
    activity.sources?.length
      ? m.integrations_activity_results({ count: activity.sources.length })
      : null,
    activity.decidedIn
      ? activity.decidedIn.decision === "allow"
        ? m.integrations_activity_approved_in({ app: activity.decidedIn.app })
        : m.integrations_activity_declined_in({ app: activity.decidedIn.app })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // A refusal is the person's or the service's decision, not a fault: it reads
  // as a quiet outcome, without the warning a real failure carries.
  const row = (
    <ActivityFace
      glyph={<IntegrationLogo integrationId={activity.integrationId} className="text-foreground" />}
      label={label}
      detail={detail || null}
      status={
        waiting ? "waiting" : running ? "running" : failed && !activity.refused ? "failed" : "done"
      }
    />
  );

  return (
    <>
      {!activity.error && !activity.link && !hiddenSummary ? (
        <div className={cn(activityRowClassName, "mb-2")} aria-label={`${name}: ${label}`}>
          {row}
        </div>
      ) : (
        <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
          <DisclosureTrigger className={disclosureTriggerClassName}>
            {row}
            <ActivityChevron open={open} />
          </DisclosureTrigger>
          <DisclosureContent>
            <div className={disclosureBodyRailClassName}>
              {hiddenSummary ? (
                <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">
                  {hiddenSummary}
                </p>
              ) : null}
              {activity.error ? (
                activity.refused ? (
                  <p className="text-xs [overflow-wrap:anywhere]">{activity.error}</p>
                ) : (
                  <ActivityNote>{activity.error}</ActivityNote>
                )
              ) : null}
              {activity.link ? (
                <a
                  href={activity.link.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground inline-flex items-center gap-1 text-xs underline underline-offset-4"
                >
                  {activity.link.title}
                  <HugeiconsIcon
                    icon={LinkSquare02Icon}
                    strokeWidth={2}
                    className="size-3"
                    aria-hidden
                  />
                </a>
              ) : null}
            </div>
          </DisclosureContent>
        </Disclosure>
      )}
    </>
  );
}

/**
 * Pressable while the answer streams, because the generation is parked on it.
 * Nothing has happened in the service yet when this shows.
 */
export function IntegrationApproval({ call }: { call: PendingIntegrationCall }) {
  const { name, label } = useIntegrationCallNames(call);
  const decide = useDecideIntegrationCall();
  const choose = (decision: IntegrationDecision) =>
    decide.mutate({ callId: call.callId, decision });
  const consequence = approvalConsequence(call, name, getLocale());
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
        <IntegrationLogo integrationId={call.integrationId} />
        <span className="min-w-0 truncate">
          {m.integrations_approval_question({ label, name })}
        </span>
      </div>
      {call.inFull ? (
        // The short list would have hidden something: everything, as it is sent.
        <pre
          aria-label={m.integrations_approval_everything()}
          className="bg-muted max-h-64 overflow-auto rounded-xl p-2 text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {call.inFull}
        </pre>
      ) : call.details?.length ? (
        // Every argument as sent, since a server's tool has no summary of its own.
        <dl className="bg-muted grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl p-2 text-xs">
          {call.details.map((entry) => (
            <div key={entry.key} className="contents">
              <dt className="text-muted-foreground font-mono">{entry.key}</dt>
              <dd className="min-w-0 [overflow-wrap:anywhere]">
                {entry.value || m.integrations_approval_empty()}
              </dd>
            </div>
          ))}
        </dl>
      ) : call.summary ? (
        <p className="bg-muted rounded-xl p-2 text-xs [overflow-wrap:anywhere]">{call.summary}</p>
      ) : null}
      {call.targets.length > 0 ? (
        <ul className="flex flex-wrap gap-1" aria-label={m.integrations_approval_recipients()}>
          {call.targets.map((target) => (
            <li key={target}>
              <Badge variant="secondary">{target}</Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-muted-foreground text-xs">{consequence}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={decide.isPending} onClick={() => choose("once")}>
          {m.integrations_approval_allow()}
        </Button>
        {call.access !== "destructive" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => choose("conversation")}
          >
            {m.integrations_approval_always()}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={decide.isPending}
          onClick={() => choose("deny")}
        >
          {m.integrations_approval_deny()}
        </Button>
      </div>
    </div>
  );
}
