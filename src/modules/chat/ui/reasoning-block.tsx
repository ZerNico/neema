import { ArrowDown01Icon, AiBrain01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { cn } from "~/ui/utils";

// ChatGPT-style thinking section above an assistant answer.
//
// Three shapes depending on what the provider gives us:
// - Visible reasoning, streaming: auto-expanded pane (max-height, auto-scroll
//   pinned to the newest thought) with a shimmering "Thinking…" header.
// - Visible reasoning, finished: collapsed one-line summary, expandable.
// - Hidden reasoning (encrypted/redacted): indicator only while thinking;
//   nothing expandable afterwards.
export function ReasoningBlock({
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
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-sm">
        <HugeiconsIcon icon={AiBrain01Icon} className="size-4 animate-pulse" />
        <span className="animate-pulse">Thinking…</span>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOverride({ during: active, value: !expanded })}
        aria-expanded={expanded}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-sm transition-colors"
      >
        <HugeiconsIcon icon={AiBrain01Icon} className={cn("size-4", active && "animate-pulse")} />
        <span className={cn(active && "animate-pulse")}>
          {active ? "Thinking…" : "Thought process"}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          className={cn("size-3.5 transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded ? (
        <div
          ref={paneRef}
          className="border-border text-muted-foreground mt-2 max-h-56 overflow-y-auto border-l-2 pl-3 text-sm leading-relaxed"
        >
          <Streamdown
            mode={active ? "streaming" : "static"}
            parseIncompleteMarkdown
            isAnimating={active}
            animated={{ animation: "fadeIn", duration: 200, easing: "ease-out", stagger: 0 }}
            className="space-y-2"
          >
            {reasoning}
          </Streamdown>
        </div>
      ) : null}
    </div>
  );
}
