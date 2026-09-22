import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { AgentDraftToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/**
 * Only rows without a draft reference reach this: anything naming a draft
 * renders the widget instead, so the outcomes here are the ones that touched
 * no draft at all.
 */
export function agentDraftActivityLabel(activity: AgentDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_agent") return "Preparing agent draft…";
    return activity.name === "update_agent_draft"
      ? "Updating agent draft…"
      : "Checking agent settings…";
  }
  return activity.result?.outcome === "options"
    ? "Checked available options"
    : "Agent draft not updated";
}

export function AgentDraftWidget({ draftId }: { draftId: string }) {
  return <DraftWidget kind="agent" draftId={draftId} icon={PencilEdit02Icon} title="Agent draft" />;
}

export function AgentDraftActivityBlock({ activity }: { activity: AgentDraftToolActivity }) {
  const reference = activity.result?.draftId;
  if (reference) return <AgentDraftWidget draftId={reference} />;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} className="size-4" aria-hidden />
      {/* The stored reason is for debugging (message_tool_calls.error), not the reader. */}
      <span className={cn(activity.status === "running" && "text-shimmer")}>
        {agentDraftActivityLabel(activity)}
      </span>
    </div>
  );
}
