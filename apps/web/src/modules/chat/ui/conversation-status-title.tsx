import * as m from "motion/react-m";
import { useState } from "react";
import type { ComponentProps } from "react";
import { Calendar03Icon, GitBranchIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ConversationTitle } from "./conversation-title.tsx";
import { MotionSwap } from "~/ui/motion.tsx";
import { motionEase } from "~/ui/motion-presets.ts";
import { useAppReducedMotion } from "~/ui/reduced-motion.ts";
import { Spinner } from "~/ui/primitives/spinner";

export function ConversationStatusTitle({
  generating,
  browsing = false,
  branched,
  scheduled = false,
  ...title
}: ComponentProps<typeof ConversationTitle> & {
  generating: boolean;
  /** Its answer is acting in one of its browser tabs, which says more than a spinner. */
  browsing?: boolean;
  branched: boolean;
  /** A schedule's chat: runs land here, so it is marked where it is found. */
  scheduled?: boolean;
}) {
  const reduced = useAppReducedMotion();
  const width = generating || browsing || branched || scheduled ? 24 : 0;
  const [slot, setSlot] = useState({ target: width, settled: width });
  if (slot.target !== width) setSlot({ ...slot, target: width });
  const moving = !reduced && slot.settled !== width;
  return (
    <>
      <m.span
        className="flex shrink-0 items-center overflow-hidden"
        initial={false}
        animate={{ width }}
        transition={{ duration: reduced ? 0 : 0.2, ease: motionEase }}
        onAnimationComplete={() =>
          setSlot((current) =>
            current.target === width ? { target: width, settled: width } : current,
          )
        }
      >
        <MotionSwap
          value={
            browsing
              ? "browsing"
              : generating
                ? "generating"
                : scheduled
                  ? "scheduled"
                  : branched
                    ? "branched"
                    : "idle"
          }
          kind="icon"
          className="size-4 shrink-0 text-muted-foreground"
        >
          {browsing ? (
            <HugeiconsIcon
              icon={Globe02Icon}
              strokeWidth={2}
              className="size-4 animate-pulse"
              aria-label="Using the browser"
            />
          ) : generating ? (
            <Spinner aria-label="Generating" className="size-4" />
          ) : scheduled ? (
            <HugeiconsIcon
              icon={Calendar03Icon}
              strokeWidth={2}
              className="size-4"
              aria-label="Scheduled chat"
            />
          ) : branched ? (
            <HugeiconsIcon
              icon={GitBranchIcon}
              strokeWidth={2}
              className="size-4"
              aria-label="Branched conversation"
            />
          ) : null}
        </MotionSwap>
      </m.span>
      <ConversationTitle {...title} resizing={moving} />
    </>
  );
}
