import { ArrowDown01Icon, LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { IntegrationToolActivity } from "~/modules/chat/client/use-message-stream.ts";
import { activityRowClassName } from "~/modules/chat/ui/activity-row.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { toastError } from "~/ui/error-toast.ts";
import { Button } from "~/ui/primitives/button";
import { Card, CardContent } from "~/ui/primitives/card";
import { cn } from "~/ui/utils";
import { pendingIntegrationCallsQuery } from "../client/queries.ts";
import type { IntegrationDecision, PendingIntegrationCall } from "../schema.ts";
import { decideIntegrationCall } from "../server/functions.ts";
import { IntegrationLogo, integrationName } from "./integration-logo.tsx";

/**
 * One call into a connected service. While it runs it may be parked on the
 * person's decision; the card for that comes from the server's list of
 * waiting calls, so a reload or another tab shows the same question.
 */
export function IntegrationActivityBlock({ activity }: { activity: IntegrationToolActivity }) {
  const running = activity.status === "running";
  const pending = useQuery({ ...pendingIntegrationCallsQuery, enabled: running });
  const waiting = running
    ? (pending.data?.find((call) => call.callId === activity.callId) ?? null)
    : null;
  const [open, setOpen] = useState(false);
  const name = integrationName(activity.integrationId);
  const failed = activity.status === "error";
  const label = waiting
    ? `Waiting for your approval: ${activity.label}`
    : running
      ? `${activity.label}…`
      : activity.refused
        ? `${activity.label}: not done`
        : failed
          ? `${activity.label} failed`
          : activity.label;
  const detail = [
    activity.summary,
    activity.sources?.length ? `${activity.sources.length} results` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const row = (
    <>
      <IntegrationLogo integrationId={activity.integrationId} className="text-foreground" />
      <span className={cn("min-w-0 truncate", running && !waiting && "text-shimmer")}>
        {label}
        {detail ? <span className="text-muted-foreground/80"> · {detail}</span> : null}
      </span>
    </>
  );

  return (
    <>
      {waiting ? <ApprovalCard call={waiting} name={name} label={activity.label} /> : null}
      {!activity.error && !activity.link ? (
        <div
          className={cn(
            activityRowClassName,
            "mb-2",
            failed && !activity.refused && "text-destructive",
          )}
          aria-label={`${name}: ${label}`}
        >
          {row}
        </div>
      ) : (
        <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
          <DisclosureTrigger className={disclosureTriggerClassName}>
            {row}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(
                "size-3.5 shrink-0",
                disclosureChevronMotionClassName,
                open && "rotate-180",
              )}
              aria-hidden
            />
          </DisclosureTrigger>
          <DisclosureContent>
            <div className={disclosureBodyRailClassName}>
              {activity.error ? (
                <p
                  className={cn(
                    "text-xs [overflow-wrap:anywhere]",
                    activity.refused ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {activity.error}
                </p>
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
function ApprovalCard({
  call,
  name,
  label,
}: {
  call: PendingIntegrationCall;
  name: string;
  label: string;
}) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: IntegrationDecision) =>
      decideIntegrationCall({ data: { callId: call.callId, decision } }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pendingIntegrationCallsQuery.queryKey }),
    onError: (error) => toastError("Could not send your answer.", error),
  });
  const verb = call.access === "read" ? "read" : call.access === "write" ? "change" : "delete";
  return (
    <Card className="mb-3 gap-0 py-4">
      <CardContent className="flex min-w-0 flex-col gap-3 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <IntegrationLogo integrationId={call.integrationId} />
          <span className="min-w-0 truncate">
            {label} in {name}?
          </span>
        </div>
        {call.summary ? (
          <p className="bg-muted rounded-xl p-2 text-xs [overflow-wrap:anywhere]">{call.summary}</p>
        ) : null}
        <p className="text-muted-foreground text-xs">
          This will {verb} with your {name} account.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate("once")}>
            Allow
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={decide.isPending}
            onClick={() => decide.mutate("deny")}
          >
            Deny
          </Button>
          {call.access !== "destructive" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => decide.mutate("conversation")}
            >
              Always allow in this chat
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
