import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ScheduleDraftToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";
import { DraftWidget } from "./draft-widget.tsx";

/** Rows without a draft reference; anything naming a draft renders the widget. */
export function scheduleDraftActivityLabel(activity: ScheduleDraftToolActivity) {
  if (activity.status === "running") {
    if (activity.name === "draft_schedule") return "Preparing schedule draft…";
    return activity.name === "update_schedule_draft"
      ? "Updating schedule draft…"
      : "Checking schedule drafts…";
  }
  return "Schedule draft not updated";
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
      <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4" aria-hidden />
      <span className={cn(activity.status === "running" && "text-shimmer")}>
        {scheduleDraftActivityLabel(activity)}
      </span>
    </div>
  );
}
