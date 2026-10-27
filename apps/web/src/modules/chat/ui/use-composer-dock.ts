import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { pendingIntegrationCallsQuery } from "~/modules/integrations/client/queries.ts";
import type { AskToolActivity } from "../client/use-message-stream.ts";
import type { DockApproval } from "./approval-dock.tsx";
import type { DesktopApprovalRequest } from "./desktop-activity-block.tsx";
import type { DisplayMessage } from "./message-list.tsx";

/**
 * What waits on the person in this chat, read from the rows the transcript
 * draws, so the live stream, a reload and a second tab ask the same thing.
 * Only the newest answer can be parked or asking: older ones are settled.
 */
export function useComposerDock({
  conversationId,
  display,
  approvalRequests,
}: {
  conversationId: string;
  display: ReadonlyArray<DisplayMessage>;
  approvalRequests: ReadonlyMap<string, DesktopApprovalRequest>;
}) {
  const tail = display.findLast((message) => message.role === "assistant");
  const activities = tail?.toolActivities;
  const integrationRunning =
    activities?.some((call) => call.family === "integration" && call.status === "running") ?? false;
  const pending = useQuery({ ...pendingIntegrationCallsQuery, enabled: integrationRunning });

  const approvals = useMemo(() => {
    const waiting = new Map(
      (pending.data ?? [])
        .filter((call) => call.conversationId === conversationId)
        .map((call) => [call.callId, call]),
    );
    const items: DockApproval[] = [];
    for (const call of activities ?? []) {
      if (call.status !== "running") continue;
      if (call.family === "desktop") {
        const approval = approvalRequests.get(call.callId);
        if (approval)
          items.push({ family: "desktop", callId: call.callId, activity: call, approval });
      } else if (call.family === "integration") {
        const parked = waiting.get(call.callId);
        if (parked) items.push({ family: "integration", callId: call.callId, call: parked });
      }
    }
    return items;
  }, [activities, approvalRequests, conversationId, pending.data]);

  // The transcript marks the one question still open; its newest call is the one asked.
  const question = tail?.questionActions?.awaiting
    ? activities?.findLast(
        (call): call is AskToolActivity =>
          call.family === "ask" && call.status === "complete" && !!call.questions?.length,
      )
    : undefined;

  return { approvals, question };
}
