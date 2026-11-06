import { m } from "~/paraglide/messages.js";
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

/** One line of a thought, without its Markdown: its first, or while it grows its newest. */
const thoughtLine = (reasoning: string, newest: boolean) => {
  const lines = reasoning
    .split("\n")
    .map((line) => line.replace(/[*_`#>]+/g, "").trim())
    .filter(Boolean);
  return (newest ? lines.at(-1) : lines[0]) ?? "";
};

/**
 * ChatGPT-style thinking section above an assistant answer.
 *
 * Three shapes, depending on the provider:
 * - Visible, streaming: auto-expanded pane (max-height, auto-scroll pinned to
 *   the newest thought) with a shimmering "Thinking…" header.
 * - Visible, finished: collapsed one-line summary, expandable.
 * - Hidden (encrypted/redacted): indicator only while thinking; nothing
 *   expandable afterwards.
 *
 * Inside a work line it is one round's thinking among that round's calls: one
 * folded line, as Claude draws it, so the steps stay what the eye follows.
 * Folded it shows where the thought starts, or while live its newest line.
 */
export const ReasoningBlock = memo(function ReasoningBlock({
  reasoning,
  active,
  inline = false,
}: {
  reasoning: string;
  /** True while the model is still thinking (nothing follows it yet). */
  active: boolean;
  /** One step of a work line, folded to a line. */
  inline?: boolean;
}) {
  const hasContent = reasoning.trim().length > 0;
  // Automatic behavior: open while the model is visibly thinking, closed once
  // it answers. A click overrides that, but only within the phase it was
  // made in (`during`), so finishing still collapses a manually opened pane
  // and a new generation re-opens a manually closed one.
  const [override, setOverride] = useState<{ during: boolean; value: boolean } | null>(null);
  const expanded = inline
    ? (override?.value ?? false)
    : override !== null && override.during === active
      ? override.value
      : active && hasContent;
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
        <ActivityFace label={m.chat_thinking()} status="running" />
      </div>
    );
  }

  const body = (
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
  );

  return (
    <Disclosure
      open={expanded}
      onOpenChange={(next) => setOverride({ during: active, value: next })}
      className="mb-2"
    >
      <DisclosureTrigger className={disclosureTriggerClassName}>
        {inline ? (
          <span className={cn("min-w-0 truncate", active && "text-shimmer")}>
            {thoughtLine(reasoning, active)}
          </span>
        ) : (
          <ActivityFace
            label={active ? m.chat_thinking() : m.chat_reasoning_done()}
            status={active ? "running" : "done"}
          />
        )}
        <ActivityChevron open={expanded} />
      </DisclosureTrigger>
      <DisclosureContent>{body}</DisclosureContent>
    </Disclosure>
  );
});
