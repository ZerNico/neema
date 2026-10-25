import { m } from "~/paraglide/messages.js";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import { cn } from "~/ui/utils";
import type { ProjectFileToolActivity } from "../client/use-message-stream.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

function projectFileActivityLabel(activity: ProjectFileToolActivity) {
  const name = activity.result?.fileName;
  if (activity.status === "running") {
    if (activity.name === "save_project_file") return m.chat_project_file_saving();
    return m.chat_project_file_checking();
  }
  switch (activity.result?.outcome) {
    case "listed":
      return m.chat_project_file_checked();
    case "saved":
      return name
        ? activity.result.version
          ? m.chat_project_file_saved_version({ name, version: activity.result.version })
          : m.chat_project_file_saved_named({ name })
        : m.chat_project_file_saved();
    default:
      return activity.name === "save_project_file"
        ? m.chat_project_file_not_saved()
        : m.chat_project_file_read_failed();
  }
}

/** One line per call: which file and version, never what it contains. */
export function ProjectFileActivityRow({ activity }: { activity: ProjectFileToolActivity }) {
  const detail = activity.status === "error" ? (activity.error ?? activity.result?.message) : null;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Folder01Icon}
        label={projectFileActivityLabel(activity)}
        detail={detail}
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
