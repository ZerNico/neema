import { m } from "~/paraglide/messages.js";
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
function memoryActivityLabel(activity: MemoryToolActivity): string {
  if (activity.status === "running") return m.chat_memory_saving();
  const project = activity.scope === "project";
  if (activity.outcome === "created")
    return project ? m.chat_memory_saved_project() : m.chat_memory_saved();
  if (activity.outcome === "updated")
    return project ? m.chat_memory_updated_project() : m.chat_memory_updated();
  if (activity.outcome === "unchanged")
    return project ? m.chat_memory_known_project() : m.chat_memory_known();
  if (activity.outcome === "rejected") return m.chat_memory_rejected();
  return m.chat_memory_failed();
}

const isMemoryFailure = (activity: MemoryToolActivity) =>
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
