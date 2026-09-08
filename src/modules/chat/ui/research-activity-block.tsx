import { GlobalSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ResearchToolActivity } from "../client/use-message-stream.ts";
import type { ResearchStepActivity } from "./research-panel.tsx";
import type { ResearchPhase } from "../research-schema.ts";
import { hostOf } from "./favicon.tsx";
import { Spinner } from "~/ui/primitives/spinner.tsx";
import { cn } from "~/ui/utils";
import { MotionSwap } from "~/ui/motion.tsx";

// Deliberately one line. What a reader wants inline is "is it still going, and
// on what", then "what did it read". The plan, task list and per-task activity
// live in the detail panel this row opens (research-panel.tsx), not here.
const activeLabels: Record<ResearchPhase, string> = {
  queued: "Starting research",
  // Clarifying is an internal decision about whether to ask anything, and it
  // lasts a second or two. Narrating it says nothing the reader wants.
  clarifying: "Starting research",
  planning: "Planning research",
  researching: "Researching",
  // Synthesis is the answer streaming in below, exactly like any reply; the
  // row has already settled by then. Kept total for exhaustiveness.
  synthesizing: "Researching",
  complete: "Researching",
  awaiting_answer: "Researching",
  partial: "Researching",
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

/** The newest running target, else the newest target seen — what it is on now. */
const currentDetail = (webActivities: ReadonlyArray<ResearchStepActivity>): string | null => {
  let latest: ResearchStepActivity | undefined;
  for (const activity of webActivities) {
    if (activity.status === "running") latest = activity;
    else if (!latest || latest.status !== "running") latest = activity;
  }
  if (!latest) return null;
  if (latest.family === "knowledge")
    return latest.name === "list_documents"
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
  // The question card that follows says everything this row would, and the
  // answered run continues in the next message — two research rows for one
  // request is the duplicate, not information.
  if (phase === "awaiting_answer") return null;

  // max-w-full: a button is shrink-to-fit, and a long unbreakable target (a
  // URL, a query without spaces) would size it past the bubble before the
  // detail span ever got the chance to truncate.
  const rowClassName = "mb-3 flex max-w-full min-w-0 items-center gap-2 text-sm";
  const buttonClassName =
    "hover:text-foreground focus-visible:ring-ring/30 rounded-lg text-left transition-colors outline-none focus-visible:ring-3";

  // Once synthesis starts the investigation is over: the row settles into its
  // finished form and the answer streams in below it like any other reply.
  const running = activity.status === "running" && phase !== "synthesizing";
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
  const primary = running ? activeLabels[phase ?? "researching"] : label;
  const secondary = running ? detail : note;
  const body = (
    <>
      <MotionSwap value={running ? "running" : "settled"} kind="icon" className="size-4 shrink-0">
        {running ? (
          <Spinner aria-hidden className="size-4 motion-reduce:animate-none" />
        ) : (
          <HugeiconsIcon icon={GlobalSearchIcon} className="size-4" aria-hidden />
        )}
      </MotionSwap>
      <MotionSwap
        value={primary}
        kind="rolling-text"
        className={cn("min-w-0", running && "shrink-0")}
      >
        <span className={cn(running && "text-shimmer font-medium")}>{primary}</span>
      </MotionSwap>
      {secondary ? (
        <>
          <span className="text-muted-foreground/40 shrink-0" aria-hidden>
            ·
          </span>
          <MotionSwap
            value={secondary}
            kind="rolling-text"
            className="text-muted-foreground min-w-0 truncate"
          >
            {secondary}
          </MotionSwap>
        </>
      ) : null}
    </>
  );
  const className = cn(rowClassName, "text-muted-foreground h-5");

  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-live="polite"
      aria-busy={running || undefined}
      className={cn(className, buttonClassName)}
    >
      {body}
    </button>
  ) : (
    <div className={className} aria-live="polite" aria-busy={running || undefined}>
      {body}
    </div>
  );
}
