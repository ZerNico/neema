import { m } from "~/paraglide/messages.js";
import { Notification03Icon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { NotifyToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

/** A scheduled run decided to tell its owner, and what it said. */
export function NotifyActivityRow({ activity }: { activity: NotifyToolActivity }) {
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Notification03Icon}
        label={
          activity.status === "running"
            ? m.chat_notify_running()
            : activity.message
              ? m.chat_notify_done({ message: activity.message })
              : m.chat_notify_failed()
        }
        status={
          activity.status === "running"
            ? "running"
            : activity.status === "error"
              ? "failed"
              : "done"
        }
      />
    </div>
  );
}
