import { CheckListIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { PlanToolActivity } from "../client/use-message-stream.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { MotionSwap } from "~/ui/motion.tsx";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";

/**
 * The model's working checklist: one collapsed row carrying the latest list.
 *
 * Deliberately understated. A completed step is the model saying it believes
 * it did that work, not a receipt, so the row summarizes progress without
 * presenting it as verified coverage.
 */
export function PlanActivityBlock({ activity }: { activity: PlanToolActivity }) {
  const [open, setOpen] = useState(false);
  const steps = activity.steps ?? [];
  const running = activity.status === "running";
  const done = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "in_progress");
  const label = running
    ? "Updating the checklist"
    : activity.status === "error" || steps.length === 0
      ? "Couldn’t update the checklist"
      : (current?.step ?? `Checklist · ${done} of ${steps.length} done`);

  if (steps.length === 0)
    return (
      <div className={cn(activityRowClassName, "mb-2")}>
        <ActivityFace icon={CheckListIcon} label={label} status={running ? "running" : "failed"} />
      </div>
    );

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <ActivityFace
          icon={CheckListIcon}
          label={label}
          detail={current ? `${done} of ${steps.length}` : null}
          status={running ? "running" : activity.status === "error" ? "failed" : "done"}
        />
        <ActivityChevron open={open} />
      </DisclosureTrigger>
      <DisclosureContent>
        <ol className={disclosureBodyRailClassName}>
          {steps.map((step) => (
            <li key={step.step} className="flex items-start gap-2 py-0.5 text-xs">
              <MotionSwap
                value={step.status === "completed" ? "completed" : "open"}
                kind="icon"
                className="h-lh w-3.5 shrink-0"
              >
                {step.status === "completed" ? (
                  <HugeiconsIcon
                    icon={Tick02Icon}
                    strokeWidth={2}
                    className="text-success size-3.5"
                    aria-hidden
                  />
                ) : (
                  <span
                    className={cn(
                      "size-1.5 rounded-full transition-colors duration-200",
                      step.status === "in_progress" ? "bg-foreground" : "bg-muted-foreground/40",
                    )}
                    aria-hidden
                  />
                )}
              </MotionSwap>
              <span
                className={cn(
                  "transition-colors duration-200 [overflow-wrap:anywhere]",
                  step.status === "completed" && "text-muted-foreground/70",
                  step.status === "in_progress" && "text-foreground",
                )}
              >
                {step.step}
              </span>
            </li>
          ))}
        </ol>
      </DisclosureContent>
    </Disclosure>
  );
}
