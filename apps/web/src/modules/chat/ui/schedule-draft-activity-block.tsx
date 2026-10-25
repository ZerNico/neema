import { Calendar03Icon } from "@hugeicons/core-free-icons";
import type { ScheduleDraftToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/** Rows without a draft reference; anything naming a draft renders the widget. */
function scheduleDraftActivityLabel(activity: ScheduleDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_schedule") return "Preparing the schedule draft";
    if (activity.name === "update_schedule_draft") return "Updating the schedule draft";
    return activity.name === "list_schedule_options"
      ? "Checking schedule settings"
      : "Checking schedule drafts";
  }
  return activity.result?.outcome === "options"
    ? "Checked available options"
    : "Couldn’t update the schedule draft";
}

export function ScheduleDraftWidget({ draftId }: { draftId: string }) {
  return (
    <DraftWidget kind="schedule" draftId={draftId} icon={Calendar03Icon} title="Schedule draft" />
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
