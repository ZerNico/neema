import { ArrowDown01Icon, ArrowShrink02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "~/ui/primitives/collapsible";
import { cn } from "~/ui/utils";

export type CompactionStatus = "running" | "complete" | "failed";

const LABELS: Record<CompactionStatus, string> = {
  running: "Summarizing earlier context…",
  complete: "Earlier context summarized",
  failed: "Couldn't summarize earlier context",
};

/**
 * A compaction pass in the same visual language as tool activity: a muted
 * one-line trigger that expands into a bordered well. It stays attached to the
 * assistant response whose generation performed the work.
 *
 * Without a summary there is nothing to expand (the pass is still running, or
 * it failed and the transcript was truncated instead), so the row is plain
 * text rather than a dead button.
 */
export function CompactionBlock({
  status,
  summary,
  outcome,
  className,
}: {
  status: CompactionStatus;
  summary?: string | undefined;
  outcome?: "summary" | "hard_truncation" | undefined;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = status === "running";
  const label =
    status === "complete" && outcome === "hard_truncation"
      ? "Earlier context truncated"
      : LABELS[status];

  if (!summary) {
    return (
      <div className={cn("text-muted-foreground flex items-center gap-1.5 text-sm", className)}>
        <HugeiconsIcon
          icon={ArrowShrink02Icon}
          className={cn("size-4", running && "animate-pulse")}
        />
        <span className={cn(running && "animate-pulse")}>{label}</span>
      </div>
    );
  }

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className={className}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors">
        <HugeiconsIcon icon={ArrowShrink02Icon} className="size-4" />
        <span>{label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "size-3.5 transition-transform duration-200 ease-out motion-reduce:transition-none",
            expanded && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none [&[hidden]:not([hidden='until-found'])]:hidden">
        <p className="border-border text-muted-foreground mt-2 border-l-2 pl-3 text-sm whitespace-pre-wrap">
          {summary}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
