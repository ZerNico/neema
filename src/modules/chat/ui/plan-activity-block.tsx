import { ArrowDown01Icon, CheckListIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { PlanToolActivity } from "../client/use-message-stream.ts";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { cn } from "~/ui/utils";

/**
 * The model's working checklist: one collapsed row carrying the latest list.
 *
 * Deliberately understated. A completed step is the model saying it believes
 * it did that work — not a receipt — so the row summarizes progress without
 * presenting it as verified coverage.
 */
export function PlanActivityBlock({ activity }: { activity: PlanToolActivity }) {
  const [open, setOpen] = useState(false);
  const steps = activity.steps ?? [];
  const running = activity.status === "running";
  const done = steps.filter((step) => step.status === "completed").length;
  const current = steps.find((step) => step.status === "in_progress");
  const label = running
    ? "Updating checklist…"
    : activity.status === "error" || steps.length === 0
      ? "Checklist unavailable"
      : (current?.step ?? `Checklist · ${done} of ${steps.length} done`);

  if (steps.length === 0)
    return (
      <div className="text-muted-foreground mb-2 flex items-center gap-1.5 text-sm">
        <HugeiconsIcon icon={CheckListIcon} className="size-4" aria-hidden />
        <span className={cn(running && "text-shimmer")}>{label}</span>
      </div>
    );

  return (
    <Disclosure open={open} onOpenChange={setOpen} className="mb-2">
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={CheckListIcon} className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
        {current ? (
          <span className="text-muted-foreground/70 shrink-0 text-xs">
            · {done} of {steps.length}
          </span>
        ) : null}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn(
            "size-3.5 shrink-0",
            disclosureChevronMotionClassName,
            open && "rotate-180",
          )}
          aria-hidden
        />
      </DisclosureTrigger>
      <DisclosureContent>
        <ol className={disclosureBodyRailClassName}>
          {steps.map((step) => (
            <li key={step.step} className="flex items-start gap-2 py-0.5 text-xs">
              <span className="flex h-lh shrink-0 items-center">
                {step.status === "completed" ? (
                  <HugeiconsIcon icon={Tick02Icon} className="text-success size-3.5" aria-hidden />
                ) : (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      step.status === "in_progress" ? "bg-foreground" : "bg-muted-foreground/40",
                    )}
                    aria-hidden
                  />
                )}
              </span>
              <span
                className={cn(
                  "[overflow-wrap:anywhere]",
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
