import { m } from "~/paraglide/messages.js";
import { ArrowShrink02Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

export type CompactionStatus = "running" | "complete" | "failed";

const LABELS: Record<CompactionStatus, () => string> = {
  running: m.chat_compaction_running,
  complete: m.chat_compaction_complete,
  failed: m.chat_compaction_failed,
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
  const face = (label: string) => (
    <ActivityFace
      icon={ArrowShrink02Icon}
      label={label}
      status={status === "complete" ? "done" : status}
    />
  );
  const label =
    status === "complete" && outcome === "hard_truncation"
      ? m.chat_compaction_truncated()
      : LABELS[status]();

  if (!summary) {
    return <div className={cn(activityRowClassName, className)}>{face(label)}</div>;
  }

  return (
    <Disclosure open={expanded} onOpenChange={setExpanded} className={className}>
      <DisclosureTrigger className={disclosureTriggerClassName}>
        {face(label)}
        <ActivityChevron open={expanded} />
      </DisclosureTrigger>
      <DisclosureContent>
        <p className={cn(disclosureBodyRailClassName, "whitespace-pre-wrap")}>{summary}</p>
      </DisclosureContent>
    </Disclosure>
  );
}
