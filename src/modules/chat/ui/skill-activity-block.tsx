import { Book02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SkillToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";

// One summary row, like memory: the disclosure only ever repeated the skill
// name back at the reader. Which supporting files were read is not something
// they need, and a skill row never implies the task was done or verified.
export function SkillActivityBlock({ activities }: { activities: SkillToolActivity[] }) {
  if (!activities.length) return null;
  const names = [
    ...new Set(
      activities
        .filter((activity) => activity.status !== "error")
        .map((activity) => activity.skillName),
    ),
  ];
  const running = activities.some((activity) => activity.status === "running");
  const label = names.length
    ? `${running ? "Using" : "Used"} ${names.join(", ")}${running ? "…" : ""}`
    : "Skill unavailable";
  return (
    <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
      <HugeiconsIcon icon={Book02Icon} className="size-4" aria-hidden />
      <span className={cn(running && "text-shimmer")}>{label}</span>
    </div>
  );
}
