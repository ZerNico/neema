import { GlobalSearchIcon } from "@hugeicons/core-free-icons";
import type { ResearchToolActivity } from "../client/use-message-stream.ts";
import type { ResearchStepActivity } from "./research-panel.tsx";
import type { ResearchPhase } from "../research-schema.ts";
import { hostOf } from "./favicon.tsx";
import { disclosureTriggerClassName } from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

// Deliberately one line. What a reader wants inline is "is it still going, and
// on what", then "what did it read". The plan, task list and per-task activity
// live in the detail panel this row opens (research-panel.tsx), not here.
const activeLabels: Record<ResearchPhase, string> = {
  queued: "Starting research",
  researching: "Researching",
  complete: "Researching",
  aborted: "Researching",
  interrupted: "Researching",
  error: "Researching",
};

// How a run that did not finish cleanly reads. When it still gathered sources
// the count leads and this becomes the qualifier, because "24 sources" is the
// part the reader can act on.
const endedEarly: Partial<Record<ResearchPhase, { alone: string; note: string }>> = {
  aborted: { alone: "Research stopped", note: "stopped early" },
  interrupted: { alone: "Research interrupted", note: "interrupted" },
  error: { alone: "Research failed", note: "ended early" },
};

/** The newest running target, else the newest target seen: what it is on now. */
const currentDetail = (webActivities: ReadonlyArray<ResearchStepActivity>): string | null => {
  let latest: ResearchStepActivity | undefined;
  for (const activity of webActivities) {
    if (activity.status === "running") latest = activity;
    else if (!latest || latest.status !== "running") latest = activity;
  }
  if (!latest) return null;
  if (latest.family === "skill") return `Using ${latest.skillName} guidance`;
  if (latest.family === "knowledge")
    return latest.name === "list_knowledge_documents"
      ? "Listing documents"
      : latest.name === "search_knowledge"
        ? "Searching knowledge"
        : "Reading documents";
  const target = latest.targets.at(-1)?.trim();
  if (!target) return null;
  return latest.name === "read_url" ? `Reading ${hostOf(target)}` : `Searching “${target}”`;
};

export function ResearchActivityBlock({
  activity,
  webActivities,
  sourceCount,
  onOpen,
}: {
  activity: ResearchToolActivity;
  webActivities: ResearchStepActivity[];
  /** Sources the message lists (cited or read); defaults to every hit the run kept. */
  sourceCount?: number;
  /** Opens the run's activity panel; absent when no panel host is mounted. */
  onOpen?: () => void;
}) {
  const progress = activity.progress;
  const phase = progress?.phase;
  // The row settles when the call returns; the answer streams in below it like
  // any other reply.
  const running = activity.status === "running";
  const detail = running ? currentDetail(webActivities) : null;

  const sources = sourceCount ?? activity.sources?.length ?? 0;
  const early = phase ? endedEarly[phase] : undefined;
  const label =
    sources > 0
      ? `Researched ${sources} source${sources === 1 ? "" : "s"}`
      : (early?.alone ?? "Research complete");
  // Only how the run ended is worth a qualifier. Individual failed reads are
  // the answer's job to route around, and the panel lists them for the curious.
  const note = sources > 0 && early ? early.note : null;
  // Before any progress (the brief still being written) it is starting.
  const primary = running ? activeLabels[phase ?? "queued"] : label;
  const secondary = running ? detail : note;
  const failed = phase === "error" && sources === 0;
  const body = (
    <ActivityFace
      icon={GlobalSearchIcon}
      label={primary}
      detail={secondary}
      status={running ? "running" : failed ? "failed" : "done"}
    />
  );

  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      aria-busy={running || undefined}
      className={cn(disclosureTriggerClassName, focusRingClassName, "mb-2 rounded-lg")}
    >
      {body}
    </button>
  ) : (
    <div
      className={cn(activityRowClassName, "mb-2")}
      aria-live="polite"
      aria-busy={running || undefined}
    >
      {body}
    </div>
  );
}
