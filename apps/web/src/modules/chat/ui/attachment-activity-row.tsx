import { m } from "~/paraglide/messages.js";
import { File01Icon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { AttachmentToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

function attachmentActivityLabel(activity: AttachmentToolActivity) {
  const read = activity.read;
  if (activity.status === "running") return m.chat_attachment_reading();
  if (!read?.ok)
    return read?.fileName
      ? m.chat_attachment_read_failed_named({ name: read.fileName })
      : m.chat_attachment_read_failed();
  const name = read.fileName;
  if (read.mode === "search") {
    const count = read.matches ?? 0;
    return name
      ? m.chat_attachment_searched_named({ name, count })
      : m.chat_attachment_searched({ count });
  }
  const whole = read.from === 0 && read.to === read.total;
  if (whole || read.from === undefined || read.to === undefined || read.total === undefined)
    return name ? m.chat_attachment_read_named({ name }) : m.chat_attachment_read();
  const from = Math.round((read.from / Math.max(read.total, 1)) * 100);
  const to = Math.round((read.to / Math.max(read.total, 1)) * 100);
  return name
    ? m.chat_attachment_read_part_named({ name, from, to })
    : m.chat_attachment_read_part({ from, to });
}

/** One line per call: which file and how much of it, never what it says. */
export function AttachmentActivityRow({ activity }: { activity: AttachmentToolActivity }) {
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={File01Icon}
        label={attachmentActivityLabel(activity)}
        status={
          activity.status === "running"
            ? "running"
            : activity.read?.ok === false || activity.status === "error"
              ? "failed"
              : "done"
        }
      />
    </div>
  );
}
