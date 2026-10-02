import { File01Icon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { AttachmentToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

export function attachmentActivityLabel(activity: AttachmentToolActivity) {
  const read = activity.read;
  if (activity.status === "running") return "Reading a file";
  if (!read?.ok)
    return read?.fileName ? `Couldn’t read ${read.fileName}` : "Couldn’t read the file";
  const name = read.fileName ?? "a file";
  if (read.mode === "search")
    return `Searched ${name}: ${read.matches ?? 0} ${read.matches === 1 ? "match" : "matches"}`;
  const whole = read.from === 0 && read.to === read.total;
  return whole || read.from === undefined || read.to === undefined || read.total === undefined
    ? `Read ${name}`
    : `Read ${name}, ${Math.round((read.from / Math.max(read.total, 1)) * 100)}–${Math.round((read.to / Math.max(read.total, 1)) * 100)}%`;
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
