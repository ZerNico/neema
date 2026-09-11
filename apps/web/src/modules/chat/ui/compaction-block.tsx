import { ArrowDown01Icon, ArrowShrink02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

export type CompactionStatus = "running" | "complete" | "failed";

const LABELS: Record<CompactionStatus, string> = {
  running: "Shortening earlier messages…",
  complete: "Earlier messages shortened",
  failed: "Couldn’t shorten earlier messages",
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
      ? "Earlier messages left out"
      : LABELS[status];

  if (!summary) {
    return (
      <div className={cn(activityRowClassName, className)}>
        <HugeiconsIcon icon={ArrowShrink02Icon} strokeWidth={2} className="size-4" aria-hidden />
        <span className={cn(running && "text-shimmer")}>{label}</span>
      </div>
    );
  }

  return (
    <Disclosure open={expanded} onOpenChange={setExpanded} className={className}>
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={ArrowShrink02Icon} strokeWidth={2} className="size-4" />
        <span>{label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn(disclosureChevronMotionClassName, "size-3.5", expanded && "rotate-180")}
        />
      </DisclosureTrigger>
      <DisclosureContent>
        <p className={cn(disclosureBodyRailClassName, "whitespace-pre-wrap")}>{summary}</p>
      </DisclosureContent>
    </Disclosure>
  );
}
