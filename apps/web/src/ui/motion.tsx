import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "~/ui/utils";
import { useAppReducedMotion } from "./reduced-motion.ts";
import { collapseMotion, motionEase } from "./motion-presets.ts";

const motionTransition = { duration: 0.16, ease: motionEase };

/**
 * One chip in a wrapping row, inside `AnimatePresence`. The child keeps its own
 * width while the wrapper grows or shrinks around it, so the text never squeezes.
 */
export function CollapseItem({ children }: { children: ReactNode }) {
  return (
    <m.div {...collapseMotion(useAppReducedMotion(), "width")} className="flex *:shrink-0">
      {children}
    </m.div>
  );
}

export function AppMotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/** Decorative swaps only: the current value is immediate, with at most one exiting ghost. */
export function MotionSwap({
  value,
  children,
  className,
  kind = "text",
}: {
  value: string;
  children: ReactNode;
  className?: string;
  kind?: "text" | "icon" | "rolling-text";
}) {
  const reduced = useAppReducedMotion();
  const [frame, setFrame] = useState({
    value,
    children,
    previous: null as ReactNode,
    revision: 0,
  });
  if (frame.value !== value) {
    setFrame({
      value,
      children,
      previous: reduced ? null : frame.children,
      revision: frame.revision + 1,
    });
  } else if (reduced && frame.previous !== null) {
    setFrame({ ...frame, previous: null });
  }
  const icon = kind === "icon";
  const rolling = kind === "rolling-text";
  const transition = rolling
    ? { duration: 0.32, ease: [0.25, 0.1, 0.25, 1] as const }
    : motionTransition;
  return (
    <span
      className={cn(
        "relative inline-grid min-w-0 items-center align-middle",
        rolling && "h-5 overflow-hidden",
        className,
      )}
    >
      {frame.previous !== null && !reduced ? (
        <m.span
          key={`out:${frame.revision}`}
          aria-hidden
          inert
          className="pointer-events-none absolute inset-0 flex min-w-0 items-center overflow-hidden"
          initial={{ opacity: 1, y: 0, scale: 1 }}
          animate={{ opacity: 0, y: rolling ? "-100%" : icon ? 0 : -4, scale: icon ? 0.85 : 1 }}
          transition={transition}
          onAnimationComplete={() =>
            setFrame((current) =>
              current.revision === frame.revision ? { ...current, previous: null } : current,
            )
          }
        >
          <span
            className={icon ? "flex size-full items-center justify-center" : "min-w-0 truncate"}
          >
            {frame.previous}
          </span>
        </m.span>
      ) : null}
      <m.span
        key={`in:${frame.revision}`}
        className={cn(
          "col-start-1 row-start-1 min-w-0",
          icon ? "flex size-full items-center justify-center" : "truncate",
        )}
        initial={
          frame.revision && !reduced
            ? { opacity: 0, y: rolling ? "100%" : icon ? 0 : 4, scale: icon ? 0.85 : 1 }
            : false
        }
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduced ? { duration: 0 } : transition}
      >
        {children}
      </m.span>
    </span>
  );
}

/**
 * Grows or shrinks to its content when `swap` changes, and only then: typing a
 * longer draft must not lag behind an animation. The last resting height is the
 * start, read before the browser paints the new content at its own height.
 */
export function HeightMorph({
  swap,
  children,
  className,
}: {
  swap: string | number | boolean;
  children: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const resting = useRef(0);
  const latest = useRef<Animation | null>(null);
  const reduced = useAppReducedMotion();
  const previous = useRef(swap);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!element.getAnimations().length) resting.current = element.offsetHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = box.current;
    if (previous.current === swap) return;
    previous.current = swap;
    if (!element || reduced || typeof element.animate !== "function") return;
    // Mid-morph, a new swap starts from where the box is now, not where it last rested.
    const running = element.getAnimations();
    const from = running.length ? element.getBoundingClientRect().height : resting.current;
    running.forEach((animation) => animation.cancel());
    const to = element.offsetHeight;
    if (!from || Math.abs(from - to) < 1) return;
    const morph = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
      duration: 240,
      easing: `cubic-bezier(${motionEase.join(",")})`,
    });
    // Clipped only while it moves: at rest a popover or focus ring may cross the edge.
    element.style.overflow = "hidden";
    latest.current = morph;
    // Only the newest morph settles: a cancelled one rejects `finished` after its
    // successor started, and must neither unclip it nor record a passing height.
    const settle = () => {
      if (latest.current !== morph) return;
      element.style.overflow = "";
      resting.current = element.offsetHeight;
    };
    morph.finished.then(settle, settle);
  }, [swap, reduced]);

  return (
    <div ref={box} className={className}>
      {children}
    </div>
  );
}
