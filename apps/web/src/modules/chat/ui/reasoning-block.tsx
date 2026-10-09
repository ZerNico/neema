import { memo, useEffect, useRef, useState } from "react";
import { markdownTableComponents } from "~/ui/markdown-components.ts";
import { Streamdown } from "streamdown";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "~/ui/disclosure.tsx";
import {
  disclosureBodyRailClassName,
  disclosureTriggerClassName,
} from "~/ui/disclosure-classes.ts";
import { markdownPlugins } from "~/ui/markdown-plugins.ts";
import { cn } from "~/ui/utils";
import { ActivityChevron, ActivityFace } from "./activity-face.tsx";
import { activityRowClassName } from "./activity-row.ts";
import { LINK_SAFETY } from "~/ui/link-safety.tsx";

/**
 * ChatGPT-style thinking section above an assistant answer.
 *
 * Three shapes, depending on the provider:
 * - Visible, streaming: auto-expanded pane (max-height, auto-scroll pinned to
 *   the newest thought) with a shimmering "Thinking…" header.
 * - Visible, finished: collapsed one-line summary, expandable.
 * - Hidden (encrypted/redacted): indicator only while thinking; nothing
 *   expandable afterwards.
 */
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
  // it answers. A click overrides that, but only within the phase it was
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
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- new reasoning text is what re-runs the scroll
  }, [reasoning, expanded, active]);

  // Hidden-reasoning providers: indicator while active, nothing afterwards.
  if (!hasContent) {
    if (!active) return null;
    return (
      <div className={cn(activityRowClassName, "mb-2")}>
        <ActivityFace label="Thinking" status="running" />
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
        <ActivityFace
          label={active ? "Thinking" : "Thought process"}
          status={active ? "running" : "done"}
        />
        <ActivityChevron open={expanded} />
      </DisclosureTrigger>
      <DisclosureContent>
        <div
          ref={paneRef}
          className={cn(disclosureBodyRailClassName, "max-h-56 overflow-y-auto leading-relaxed")}
        >
          <Streamdown
            linkSafety={LINK_SAFETY}
            mode={active ? "streaming" : "static"}
            parseIncompleteMarkdown
            plugins={markdownPlugins}
            components={markdownTableComponents}
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
