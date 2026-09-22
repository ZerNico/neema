import { ArrowDown01Icon, CodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { CustomToolActivity } from "../client/use-message-stream.ts";
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

/**
 * One admin-authored code tool call. The row carries the tool's display name
 * and status; the result preview sits behind a disclosure, since the full
 * output already went to the model and is never retransmitted here. Files the
 * call returned are not listed: they render inline right after this row, at
 * the same text offset, and a second chip here read as a second file.
 */
export function CustomToolActivityBlock({ activity }: { activity: CustomToolActivity }) {
  const [open, setOpen] = useState(false);
  const running = activity.status === "running";
  const failed = activity.status === "error";
  const label = running
    ? `Running ${activity.displayName}…`
    : failed
      ? `${activity.displayName} failed`
      : activity.displayName;

  if (!activity.resultPreview && !activity.error)
    return (
      <div className={cn(activityRowClassName, "mb-2", failed && "text-destructive")}>
        <HugeiconsIcon icon={CodeIcon} strokeWidth={2} className="size-4" aria-hidden />
        <span className={cn(running && "text-shimmer")}>{label}</span>
      </div>
    );

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={CodeIcon} strokeWidth={2} className="size-4 shrink-0" aria-hidden />
        <span className={cn("min-w-0 truncate", running && "text-shimmer")}>{label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn(
            "size-3.5 shrink-0",
            disclosureChevronMotionClassName,
            open && "rotate-180",
          )}
          aria-hidden
        />
      </DisclosureTrigger>
      <DisclosureContent>
        <div className={disclosureBodyRailClassName}>
          {failed && activity.error ? (
            <p className="text-destructive mb-1 text-xs [overflow-wrap:anywhere]">
              {activity.error}
            </p>
          ) : null}
          {activity.resultPreview ? (
            <p className="text-muted-foreground text-xs [overflow-wrap:anywhere] whitespace-pre-wrap">
              {activity.resultPreview}
              {activity.resultChars !== undefined &&
              activity.resultChars > activity.resultPreview.length
                ? ` (${activity.resultChars} chars)`
                : ""}
            </p>
          ) : null}
        </div>
      </DisclosureContent>
    </Disclosure>
  );
}
