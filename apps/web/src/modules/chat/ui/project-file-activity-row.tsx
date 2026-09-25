import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "~/ui/utils";
import type { ProjectFileToolActivity } from "../client/use-message-stream.ts";
import { activityRowClassName } from "./activity-row.ts";

export function projectFileActivityLabel(activity: ProjectFileToolActivity) {
  const name = activity.result?.fileName;
  if (activity.status === "running") {
    if (activity.name === "save_project_file") return "Saving to the project…";
    if (activity.name === "read_project_file") return "Reading a project file…";
    return "Checking project files…";
  }
  switch (activity.result?.outcome) {
    case "listed":
      return "Checked project files";
    case "read":
      return name ? `Read ${name}` : "Read a project file";
    case "saved":
      return name
        ? `Saved ${name}${activity.result.version ? ` as version ${activity.result.version}` : ""}`
        : "Saved a project file";
    default:
      return activity.name === "save_project_file"
        ? "Not saved to the project"
        : "Couldn’t read project files";
  }
}

/** One line per call: which file and version, never what it contains. */
export function ProjectFileActivityRow({ activity }: { activity: ProjectFileToolActivity }) {
  const detail = activity.status === "error" ? (activity.error ?? activity.result?.message) : null;
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <HugeiconsIcon icon={Folder01Icon} strokeWidth={2} className="size-4 shrink-0" aria-hidden />
      <span className={cn("min-w-0", activity.status === "running" && "text-shimmer")}>
        {projectFileActivityLabel(activity)}
        {detail ? `: ${detail}` : null}
      </span>
    </div>
  );
}
