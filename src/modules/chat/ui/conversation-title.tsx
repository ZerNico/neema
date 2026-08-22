import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

// The reveal has to be in place before the browser paints the resolved title,
// otherwise the full text flashes for a frame first.
const useRevealEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);

/**
 * A conversation's title in the sidebar. Null means generation is still
 * running, which shows a placeholder; the title that resolves it types itself
 * in — once per conversation, never on a later refetch, reload or rename.
 */
export function ConversationTitle({
  conversationId,
  title,
  registry,
}: {
  conversationId: string;
  title: string | null;
  registry: TitleRevealRegistry;
}) {
  // Character count during a reveal; null means "show all of it".
  const [shown, setShown] = useState<number | null>(null);
  // Cached per title so React re-running effects on the same instance
  // (StrictMode) replays the reveal instead of swallowing it.
  const decision = useRef<{ title: string; reveal: boolean } | null>(null);

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
    if (!decision.current.reveal || prefersReducedMotion()) {
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
  }, [conversationId, title, registry]);

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
  return (
    <span
      data-title-state={revealing ? "revealing" : "ready"}
      // Always the whole title, so screen readers announce it once instead of
      // once per character.
      aria-label={revealing ? title : undefined}
      className="truncate"
    >
      <span aria-hidden={revealing || undefined}>{revealing ? title.slice(0, shown) : title}</span>
      {revealing ? (
        <span
          aria-hidden
          className="bg-foreground/70 ml-px inline-block h-[1em] w-px translate-y-[0.15em] animate-pulse"
        />
      ) : null}
    </span>
  );
}
