import { m } from "~/paraglide/messages.js";
import { ArrowRight01Icon, GlobalSearchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { serverNow } from "../client/use-message-stream.ts";
import type { ResearchToolActivity } from "../client/use-message-stream.ts";
import type { ResearchStepActivity } from "./research-panel.tsx";
import type { ResearchPhase } from "../research-schema.ts";
import { gatheredPages } from "./research-steps.ts";
import { cn } from "~/ui/utils";
import { focusRingClassName } from "~/ui/focus-ring.ts";
import { ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { FaviconStack } from "./tool-activity-block.tsx";
import { useElapsed } from "./use-elapsed.ts";
import { formatDuration } from "./work-steps.ts";

// A card rather than a row: a run lasts minutes and is the one tool call a
// reader may want to follow. It says what the run is about, how much it has
// gathered and for how long. The plan, topics and steps live in the panel it
// opens (research-panel.tsx).

// How a run that did not finish cleanly reads. When it still gathered sources
// the count leads and this becomes the qualifier, because "24 sources" is the
// part the reader can act on.
const endedEarly: Partial<Record<ResearchPhase, { alone: () => string; note: () => string }>> = {
  aborted: { alone: m.chat_research_stopped, note: m.chat_research_stopped_note },
  interrupted: { alone: m.chat_research_interrupted, note: m.chat_research_interrupted_note },
  error: { alone: m.chat_research_failed, note: m.chat_research_failed_note },
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
  // The card settles when the call returns; the answer streams in below it
  // like any other reply.
  const running = activity.status === "running";
  const pages = gatheredPages(webActivities);
  // What the run gathered, as the panel counts it; the message's own list
  // stands in where the steps are not loaded.
  const sources = pages.size || (running ? 0 : (sourceCount ?? activity.sources?.length ?? 0));
  const early = phase ? endedEarly[phase] : undefined;
  const topics = progress?.tasks.length ?? 0;

  const line = running
    ? sources > 0
      ? m.chat_research_sources_so_far({ count: sources })
      : topics > 0
        ? m.chat_research_planned({ count: topics })
        : m.chat_research_planning()
    : sources > 0
      ? m.chat_research_sources({ count: sources })
      : (early?.alone() ?? m.chat_research_no_sources());
  // Only how the run ended is worth a qualifier. Individual failed reads are
  // the answer's job to route around, and the panel lists them for the curious.
  const note = !running && sources > 0 ? early?.note() : undefined;
  const failed = !running && phase === "error" && sources === 0;
  const [mountedAt] = useState(serverNow);
  const since = activity.startedAt ?? mountedAt;
  const elapsed = useElapsed(since, running);
  const took =
    activity.startedAt !== undefined && activity.completedAt !== undefined
      ? activity.completedAt - activity.startedAt
      : null;
  const time = running ? elapsed : took;
  const sites = [...new Map([...pages].map(([url, site]) => [site, url])).values()].slice(-3);

  const body = (
    <>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn("text-foreground truncate text-sm font-medium", running && "text-shimmer")}
        >
          {progress?.title ?? m.chat_research_title()}
        </span>
        <span className={activityRowClassName}>
          <ActivityFace
            {...(sites.length
              ? { glyph: <FaviconStack urls={sites} /> }
              : { icon: GlobalSearchIcon })}
            label={line}
            detail={note}
            status={failed ? "failed" : "done"}
          />
          {time !== null && !note ? (
            // Ticks every second, so it is left out of what a screen reader hears.
            <span className="-ml-0.5 shrink-0 tabular-nums" aria-hidden={running || undefined}>
              · {formatDuration(time)}
            </span>
          ) : null}
        </span>
      </span>
      {onOpen ? (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden
        />
      ) : null}
    </>
  );
  const card =
    "border-border mb-2 flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left";

  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={running || undefined}
      className={cn(card, focusRingClassName, "hover:bg-muted/50 transition-colors")}
    >
      {body}
    </button>
  ) : (
    <div className={card} aria-busy={running || undefined}>
      {body}
    </div>
  );
}
