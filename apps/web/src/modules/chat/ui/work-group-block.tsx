import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { pendingIntegrationCallsQuery } from "~/modules/integrations/client/queries.ts";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { serverNow } from "../client/use-message-stream.ts";
import { useElapsed } from "./use-elapsed.ts";
import type { WorkPart, WorkStep } from "./assistant-body.ts";
import { ActivityChevron } from "./activity-face.tsx";
import { useRunDisclosure } from "./use-run-disclosure.ts";
import { formatDuration, stepActivities, workStart, workSummary } from "./work-steps.ts";

/**
 * Mounted only while an integration call runs, so a chat without one never
 * asks the server which calls are parked on the person.
 */
function IntegrationApprovalWatch({
  callIds,
  onWaiting,
}: {
  callIds: ReadonlyArray<string>;
  onWaiting: (waiting: boolean) => void;
}) {
  const pending = useQuery(pendingIntegrationCallsQuery);
  const waiting = pending.data?.some((call) => callIds.includes(call.callId)) ?? false;
  useEffect(() => {
    onWaiting(waiting);
    return () => onWaiting(false);
  }, [waiting, onWaiting]);
  return null;
}

/**
 * One line for a run of work. While it is the newest part of a streaming
 * answer it stays open, its header saying "Working" with a running clock while
 * the steps below name the detail; once the answer moves on it folds into what
 * it did, "Searched the web and read 2 pages".
 */
export function WorkGroupBlock({
  part,
  live,
  renderStep,
  approvals,
}: {
  part: WorkPart;
  /** The newest part of a streaming answer. */
  live: boolean;
  /** Desktop and browser calls parked on the person's decision. */
  approvals?: ReadonlyMap<string, unknown> | undefined;
  renderStep: (step: WorkStep) => ReactNode;
}) {
  const calls = part.steps.flatMap(stepActivities);
  const running = live || calls.some((call) => call.status === "running");
  const { expanded, onOpenChange } = useRunDisclosure(running);
  // Reasoning alone has no recorded start; the clock then starts when this
  // row first appears, which is when the work became visible.
  const [mountedAt] = useState(serverNow);
  const elapsed = useElapsed(workStart(part.steps) ?? mountedAt, running);
  // No failure count here: a step the model retried or worked around is not
  // news for the reader, and counting it read as alarming. Each step's own row
  // marks a failure, and the answer says when one mattered.

  // A decision is never folded away: a step parked on the person holds the
  // line open and says so, whatever it was collapsed to.
  const [integrationWaiting, setIntegrationWaiting] = useState(false);
  const runningIntegrations = calls.flatMap((call) =>
    call.family === "integration" && call.status === "running" ? [call.callId] : [],
  );
  const waiting =
    calls.some((call) => call.status === "running" && approvals?.has(call.callId)) ||
    (runningIntegrations.length > 0 && integrationWaiting);

  // Live, the steps below name the detail and the header only that it is busy
  // and for how long: "Thinking" between calls read as stalled. Settled, it says
  // what was done, not how long, since the time spent thinking is not recorded.
  const label = waiting
    ? "Waiting for you"
    : running
      ? `Working · ${formatDuration(elapsed)}`
      : workSummary(part.steps);

  return (
    <Disclosure open={expanded || waiting} onOpenChange={onOpenChange} className="mb-2">
      {runningIntegrations.length > 0 ? (
        <IntegrationApprovalWatch callIds={runningIntegrations} onWaiting={setIntegrationWaiting} />
      ) : null}
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <span className={cn("min-w-0 truncate", running && !waiting && "text-shimmer")}>
          {label}
        </span>
        <ActivityChevron open={expanded || waiting} />
      </DisclosureTrigger>
      <DisclosureContent>
        {/* Flush, not railed: each step row draws its own rail, and a second one
            around them nested two borders where ChatGPT shows a plain list. */}
        <div className="mt-2 flex flex-col">{part.steps.map((step) => renderStep(step))}</div>
      </DisclosureContent>
    </Disclosure>
  );
}
