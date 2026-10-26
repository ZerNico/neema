import { m } from "~/paraglide/messages.js";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import type { ScheduleDraftToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/** Rows without a draft reference; anything naming a draft renders the widget. */
function scheduleDraftActivityLabel(activity: ScheduleDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_schedule") return m.schedules_activity_preparing();
    if (activity.name === "update_schedule_draft") return m.schedules_activity_updating();
    return activity.name === "list_schedule_options"
      ? m.schedules_activity_checking_settings()
      : m.schedules_activity_checking_drafts();
  }
  return activity.result?.outcome === "options"
    ? m.drafts_activity_checked_options()
    : m.schedules_activity_update_failed();
}

export function ScheduleDraftWidget({ draftId }: { draftId: string }) {
  return (
    <DraftWidget
      kind="schedule"
      draftId={draftId}
      icon={Calendar03Icon}
      title={m.schedules_draft_title()}
      openLabel={(name) => m.schedules_draft_open_named({ name })}
    />
  );
}

export function ScheduleDraftActivityBlock({ activity }: { activity: ScheduleDraftToolActivity }) {
  const reference = activity.result?.draftId;
  if (reference) return <ScheduleDraftWidget draftId={reference} />;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Calendar03Icon}
        label={scheduleDraftActivityLabel(activity)}
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
