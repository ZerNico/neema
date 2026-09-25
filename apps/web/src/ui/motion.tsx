import { LazyMotion, MotionConfig, domAnimation } from "motion/react";
import * as m from "motion/react-m";
import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { cn } from "~/ui/utils";

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";
export const prefersReducedMotion = () =>
  typeof window !== "undefined" && (window.matchMedia?.(reducedMotionQuery).matches ?? false);
const serverReducedMotion = () => false;
const subscribeReducedMotion = (notify: () => void) => {
  const query = typeof window !== "undefined" ? window.matchMedia?.(reducedMotionQuery) : undefined;
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};

export const useAppReducedMotion = () =>
  useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, serverReducedMotion);

export const motionEase = [0.22, 1, 0.36, 1] as const;
export const motionTransition = { duration: 0.16, ease: motionEase };

/**
 * Enter and exit for an item inside `AnimatePresence` whose neighbours should
 * close the gap rather than jump. `MotionConfig`'s reduced motion only drops
 * transforms, so size is switched off here. Overflow clips only while moving,
 * since a resting item may hold focus rings or an attached popover.
 */
export function collapseMotion(reduced: boolean, axis: "height" | "width" = "height") {
  const closed = { opacity: 0, overflow: "hidden" } as const;
  const open = { opacity: 1, transitionEnd: { overflow: "visible" } } as const;
  const vertical = axis === "height";
  return {
    initial: vertical ? { ...closed, height: 0 } : { ...closed, width: 0 },
    animate: vertical ? { ...open, height: "auto" } : { ...open, width: "auto" },
    exit: vertical ? { ...closed, height: 0 } : { ...closed, width: 0 },
    transition: reduced ? { duration: 0 } : { duration: 0.2, ease: motionEase },
  };
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
