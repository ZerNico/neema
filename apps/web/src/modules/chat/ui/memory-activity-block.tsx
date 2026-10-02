import { Brain02Icon } from "@hugeicons/core-free-icons";
import type { MemoryToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

/**
 * A refused save is the model deciding wrong or a policy declining, not the
 * app failing: it reads as a quiet outcome, never as a fault to act on. Only a
 * save that never completed (transport, defect, interruption) is an error.
 */
export function memoryActivityLabel(activity: MemoryToolActivity): string {
  if (activity.status === "running") return "Saving to memory…";
  const project = activity.scope === "project";
  if (activity.outcome === "created")
    return project ? "Saved to project memory" : "Saved to memory";
  if (activity.outcome === "updated") return project ? "Updated project memory" : "Updated memory";
  if (activity.outcome === "unchanged")
    return project ? "Project already knows this" : "Memory already saved";
  if (activity.outcome === "rejected") return "No memory saved";
  return "Couldn’t save memory";
}

export const isMemoryFailure = (activity: MemoryToolActivity) =>
  activity.status === "error" && activity.outcome !== "rejected";

/**
 * Memory activity is intentionally a single summary row: unlike web tools it
 * has no disclosure, links, favicons, targets, sources, or persisted content.
 */
export function MemoryActivityBlock({ activity }: { activity: MemoryToolActivity }) {
  const running = activity.status === "running";
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Brain02Icon}
        label={memoryActivityLabel(activity)}
        status={running ? "running" : isMemoryFailure(activity) ? "failed" : "done"}
      />
    </div>
  );
}
