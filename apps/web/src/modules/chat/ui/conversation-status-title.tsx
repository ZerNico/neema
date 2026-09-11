import * as m from "motion/react-m";
import { useState } from "react";
import type { ComponentProps } from "react";
import { GitBranchIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ConversationTitle } from "./conversation-title.tsx";
import { MotionSwap, motionEase, useAppReducedMotion } from "~/ui/motion.tsx";
import { Spinner } from "~/ui/primitives/spinner";

export function ConversationStatusTitle({
  generating,
  branched,
  ...title
}: ComponentProps<typeof ConversationTitle> & { generating: boolean; branched: boolean }) {
  const reduced = useAppReducedMotion();
  const width = generating || branched ? 24 : 0;
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
          value={generating ? "generating" : branched ? "branched" : "idle"}
          kind="icon"
          className="size-4 shrink-0 text-muted-foreground"
        >
          {generating ? (
            <Spinner aria-label="Generating" className="size-4 motion-reduce:animate-none" />
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
