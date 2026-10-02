import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { AgentDraftToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/**
 * Only rows without a draft reference reach this: anything naming a draft
 * renders the widget instead, so the outcomes here are the ones that touched
 * no draft at all.
 */
export function agentDraftActivityLabel(activity: AgentDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_agent") return "Preparing the agent draft";
    return activity.name === "update_agent_draft"
      ? "Updating the agent draft"
      : "Checking agent settings";
  }
  return activity.result?.outcome === "options"
    ? "Checked available options"
    : "Couldn’t update the agent draft";
}

export function AgentDraftWidget({ draftId }: { draftId: string }) {
  return <DraftWidget kind="agent" draftId={draftId} icon={PencilEdit02Icon} title="Agent draft" />;
}

export function AgentDraftActivityBlock({ activity }: { activity: AgentDraftToolActivity }) {
  const reference = activity.result?.draftId;
  if (reference) return <AgentDraftWidget draftId={reference} />;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      {/* The stored reason is for debugging (message_tool_calls.error), not the reader. */}
      <ActivityFace
        icon={PencilEdit02Icon}
        label={agentDraftActivityLabel(activity)}
        status={
          activity.status === "running"
            ? "running"
            : activity.result?.outcome === "options"
              ? "done"
              : "failed"
        }
      />
    </div>
  );
}
