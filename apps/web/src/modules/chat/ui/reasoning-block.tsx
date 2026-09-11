import { ArrowDown01Icon, AiBrain01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { memo, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  disclosureBodyRailClassName,
  disclosureChevronMotionClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure.tsx";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { cn } from "~/ui/utils";
import { activityRowClassName } from "./activity-row.ts";

// ChatGPT-style thinking section above an assistant answer.
//
// Three shapes depending on what the provider gives us:
// - Visible reasoning, streaming: auto-expanded pane (max-height, auto-scroll
//   pinned to the newest thought) with a shimmering "Thinking…" header.
// - Visible reasoning, finished: collapsed one-line summary, expandable.
// - Hidden reasoning (encrypted/redacted): indicator only while thinking;
//   nothing expandable afterwards.
export const ReasoningBlock = memo(function ReasoningBlock({
  reasoning,
  active,
}: {
  reasoning: string;
  /** True while the model is still thinking (no answer text yet). */
  active: boolean;
}) {
  const hasContent = reasoning.trim().length > 0;
  // Automatic behavior: open while the model is visibly thinking, closed once
  // it answers. A click overrides that — but only within the phase it was
  // made in (`during`), so finishing still collapses a manually opened pane
  // and a new generation re-opens a manually closed one.
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const expanded =
    override !== null && override.during === active ? override.value : active && hasContent;
  const paneRef = useRef<HTMLDivElement>(null);

  // Keep the newest thought in view while streaming.
  useEffect(() => {
    if (expanded && active && paneRef.current) {
      paneRef.current.scrollTop = paneRef.current.scrollHeight;
    }
  }, [reasoning, expanded, active]);

  // Hidden-reasoning providers: indicator while active, nothing afterwards.
  if (!hasContent) {
    if (!active) return null;
    return (
      <div className={cn(activityRowClassName, "mb-2 gap-2")}>
        <HugeiconsIcon icon={AiBrain01Icon} strokeWidth={2} className="size-4" aria-hidden />
        <span className="text-shimmer">Thinking…</span>
      </div>
    );
  }

  return (
    <Disclosure
      open={expanded}
      onOpenChange={(next) => setOverride({ during: active, value: next })}
      className="mb-2"
    >
      <DisclosureTrigger className={disclosureTriggerClassName}>
        <HugeiconsIcon icon={AiBrain01Icon} strokeWidth={2} className="size-4" aria-hidden />
        <span className={cn(active && "text-shimmer")}>
          {active ? "Thinking…" : "Thought process"}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className={cn(disclosureChevronMotionClassName, "size-3.5", expanded && "rotate-180")}
        />
      </DisclosureTrigger>
      <DisclosureContent>
        <div
          ref={paneRef}
          className={cn(disclosureBodyRailClassName, "max-h-56 overflow-y-auto leading-relaxed")}
        >
          <Streamdown
            mode={active ? "streaming" : "static"}
            parseIncompleteMarkdown
            plugins={markdownPlugins}
            isAnimating={active}
            animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
            className="space-y-2"
          >
            {reasoning}
          </Streamdown>
        </div>
      </DisclosureContent>
    </Disclosure>
  );
});
