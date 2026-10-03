import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { relativeAgeLabel } from "./timestamps.ts";
import { useAppReducedMotion } from "~/ui/motion.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";

/**
 * Which conversations have been seen untitled, and which have already played
 * their reveal. Owned by the mounted sidebar rather than by a row (so it
 * survives refetches and reordering) and never module-global, which on the
 * server would be shared across users.
 */
export interface TitleRevealRegistry {
  readonly pending: Set<string>;
  readonly revealed: Set<string>;
}

export const createTitleRevealRegistry = (): TitleRevealRegistry => ({
  pending: new Set(),
  revealed: new Set(),
});

const REVEAL_DURATION_MS = 600;
const TITLE_TOOLTIP_DELAY_MS = 600;
const TITLE_SCROLL_PX_PER_SECOND = 32;
const TITLE_SCROLL_MIN_MS = 1_200;
const TITLE_SCROLL_MAX_MS = 10_000;
const TITLE_SCROLL_END_GAP_PX = 12;
const RIGHT_EDGE_FADE =
  "linear-gradient(to right, black 0, black calc(100% - 1rem), transparent 100%)";
const BOTH_EDGE_FADE =
  "linear-gradient(to right, transparent 0, black 0.75rem, black calc(100% - 0.75rem), transparent 100%)";

// The reveal has to be in place before the browser paints the resolved title,
// otherwise the full text flashes for a frame first.
const useRevealEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * A conversation's title. Null means generation is still running, which shows
 * a placeholder; the title that resolves it types itself in once. Supplying a
 * creation time opts the narrow sidebar instance into overflow scrolling and
 * its delayed full-title preview; wider list rows keep the plain title.
 */
export function ConversationTitle({
  conversationId,
  title,
  registry,
  createdAt,
  resizing = false,
}: {
  conversationId: string;
  title: string | null;
  registry: TitleRevealRegistry;
  createdAt?: Date | string | number;
  /** Defer overflow measurement while the sidebar status slot changes width. */
  resizing?: boolean;
}) {
  const reduced = useAppReducedMotion();
  // Character count during a reveal; null means "show all of it".
  const [shown, setShown] = useState<number | null>(null);
  // Cached per title so React re-running effects on the same instance
  // (StrictMode) replays the reveal instead of swallowing it.
  const decision = useRef<{ title: string; reveal: boolean } | null>(null);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowDistance, setOverflowDistance] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [previewNow, setPreviewNow] = useState<Date | null>(null);

  useRevealEffect(() => {
    if (title === null) {
      registry.pending.add(conversationId);
      setShown(null);
      return;
    }

    if (decision.current?.title !== title) {
      const reveal = registry.pending.has(conversationId) && !registry.revealed.has(conversationId);
      registry.revealed.add(conversationId);
      decision.current = { title, reveal };
    }
    if (!decision.current.reveal || reduced) {
      setShown(null);
      return;
    }

    setShown(0);
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const progress = Math.min(1, (now - start) / REVEAL_DURATION_MS);
      setShown(progress === 1 ? null : Math.ceil(progress * title.length));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [conversationId, title, registry, reduced]);

  useLayoutEffect(() => {
    if (resizing || createdAt === undefined || title === null || shown !== null) return;

    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;

    const measure = () => {
      const next = Math.max(0, text.scrollWidth - viewport.clientWidth);
      setOverflowDistance((current) => (current === next ? current : next));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [createdAt, shown, title, resizing]);

  if (title === null) {
    return (
      <span
        data-title-state="pending"
        aria-label="Generating title"
        className="text-muted-foreground animate-pulse truncate italic motion-reduce:animate-none"
      >
        New chat…
      </span>
    );
  }

  const revealing = shown !== null;
  const visibleTitle = revealing ? title.slice(0, shown) : title;
  const titleContents = (
    <>
      <span aria-hidden={revealing || undefined}>{visibleTitle}</span>
      {revealing ? (
        <span
          aria-hidden
          className="bg-foreground/70 ml-px inline-block h-[1em] w-px translate-y-[0.15em] animate-pulse"
        />
      ) : null}
    </>
  );

  if (createdAt === undefined) {
    return (
      <span
        data-title-state={revealing ? "revealing" : "ready"}
        // Always the whole title, so screen readers announce it once instead of
        // once per character.
        aria-label={revealing ? title : undefined}
        className="truncate"
      >
        {titleContents}
      </span>
    );
  }

  const overflowing = !revealing && overflowDistance > 0;
  const scrolling = overflowing && hovered && !reduced;
  const scrollDistance = overflowDistance + TITLE_SCROLL_END_GAP_PX;
  const scrollDuration = Math.min(
    TITLE_SCROLL_MAX_MS,
    Math.max(TITLE_SCROLL_MIN_MS, (scrollDistance / TITLE_SCROLL_PX_PER_SECOND) * 1_000),
  );
  const mask = scrolling ? BOTH_EDGE_FADE : RIGHT_EDGE_FADE;
  const relativeAge = relativeAgeLabel(createdAt, previewNow ?? new Date());
  const viewportStyle: CSSProperties | undefined = overflowing
    ? { maskImage: mask, WebkitMaskImage: mask }
    : undefined;
  const textStyle: CSSProperties = {
    transform: scrolling ? `translateX(-${scrollDistance}px)` : "translateX(0)",
    transitionDuration: `${scrolling ? scrollDuration : 180}ms`,
    transitionTimingFunction: scrolling ? "linear" : "ease-out",
  };

  return (
    <Tooltip
      onOpenChange={(open) => {
        if (open) setPreviewNow(new Date());
      }}
    >
      <TooltipTrigger
        delay={TITLE_TOOLTIP_DELAY_MS}
        render={
          <span
            ref={viewportRef}
            data-title-state={revealing ? "revealing" : "ready"}
            data-title-overflowing={overflowing || undefined}
            data-title-scrolling={scrolling || undefined}
            aria-label={revealing ? title : undefined}
            className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap text-clip"
            style={viewportStyle}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
          />
        }
      >
        <span
          ref={textRef}
          data-title-text
          className="inline-block min-w-max transition-transform motion-reduce:transition-none"
          style={textStyle}
        >
          {titleContents}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" sideOffset={48} showArrow={false}>
        <span className="flex flex-col gap-0.5">
          <span className="font-medium leading-snug">{title}</span>
          {relativeAge ? (
            <span className="text-muted-foreground leading-snug">Created {relativeAge}</span>
          ) : null}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}
