import { m } from "~/paraglide/messages.js";
import { Book02Icon } from "@hugeicons/core-free-icons";
import type { SkillToolActivity } from "../client/use-message-stream.ts";
import { cn } from "~/ui/utils";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

/**
 * One summary row, like memory: the disclosure only ever repeated the skill
 * name back at the reader. Which supporting files were read is not something
 * they need, and a skill row never implies the task was done or verified.
 */
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
    ? running
      ? m.chat_skill_using({ names: names.join(", ") })
      : m.chat_skill_used({ names: names.join(", ") })
    : m.chat_skill_failed();
  return (
    <div className={cn(activityRowClassName, "mb-2")}>
      <ActivityFace
        icon={Book02Icon}
        label={label}
        status={running ? "running" : names.length ? "done" : "failed"}
      />
    </div>
  );
}
