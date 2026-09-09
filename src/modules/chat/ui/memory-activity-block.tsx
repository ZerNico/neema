import { Brain02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { MemoryToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

export function memoryActivityLabel(activity: MemoryToolActivity): string {
  if (activity.status === "running") return "Saving to memory…";
  if (activity.status === "error" || activity.outcome === "rejected") {
    return "Couldn’t save memory";
  }
  if (activity.outcome === "created") return "Saved to memory";
  if (activity.outcome === "updated") return "Updated memory";
  if (activity.outcome === "unchanged") return "Memory already saved";
  return "Couldn’t save memory";
}

// Memory activity is intentionally a single summary row: unlike web tools it
// has no disclosure, links, favicons, targets, sources, or persisted content.
export function MemoryActivityBlock({ activity }: { activity: MemoryToolActivity }) {
  const running = activity.status === "running";
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <HugeiconsIcon icon={Brain02Icon} strokeWidth={2} className="size-4" aria-hidden />
      <span className={cn(running && "text-shimmer")}>{memoryActivityLabel(activity)}</span>
    </div>
  );
}
