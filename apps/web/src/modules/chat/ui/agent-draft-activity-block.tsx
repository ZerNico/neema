import { m } from "~/paraglide/messages.js";
import { PencilEdit02Icon } from "@hugeicons/core-free-icons";
import type { AgentDraftToolActivity } from "../client/use-message-stream.ts";
import { m } from "~/paraglide/messages.js";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/**
 * Only rows without a draft reference reach this: anything naming a draft
 * renders the widget instead, so the outcomes here are the ones that touched
 * no draft at all.
 */
function agentDraftActivityLabel(activity: AgentDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_agent") return m.agents_activity_preparing();
    return activity.name === "update_agent_draft"
      ? m.agents_activity_updating()
      : m.agents_activity_checking_settings();
  }
  return activity.result?.outcome === "options"
    ? m.drafts_activity_checked_options()
    : m.agents_activity_update_failed();
}

export function AgentDraftWidget({ draftId }: { draftId: string }) {
  return (
    <DraftWidget
      kind="agent"
      draftId={draftId}
      icon={PencilEdit02Icon}
      title={m.agents_draft_title()}
      openLabel={(name) => m.agents_draft_open_named({ name })}
    />
  );
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
