// A block changes height when its skeleton gives way to the real tree, and
// again on each streaming re-render. Following the content's measured height
// turns those jumps into a short glide, as ChatGPT's blocks do.
//
// The height is driven by hand rather than through Motion: animating from
// `auto` left the container unsized, so it grew with its content in the same
// frame and the glide that followed went from the new height to itself.

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { motionEase } from "~/ui/motion-presets.ts";
import { prefersReducedMotion } from "~/ui/reduced-motion.ts";

const GLIDE = { duration: 220, easing: `cubic-bezier(${motionEase.join(", ")})` } as const;

export function SmoothHeight({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content || typeof ResizeObserver === "undefined") return;
    let target = content.offsetHeight;
    // Always an explicit height: the observer runs before paint, so new
    // content never shows at its full size before the glide starts.
    box.style.height = `${target}px`;
    let glide: Animation | null = null;
    const settle = () => {
      glide = null;
      // Clipped only while moving: at rest a block holds focus rings and shadows.
      box.style.overflow = "";
    };
    const observer = new ResizeObserver(() => {
      const next = content.offsetHeight;
      if (next === target) return;
      // From where it is now, so a change mid-glide continues instead of restarting.
      const from = glide ? box.getBoundingClientRect().height : target;
      glide?.cancel();
      target = next;
      box.style.height = `${next}px`;
      if (prefersReducedMotion() || from === next || typeof box.animate !== "function") {
        settle();
        return;
      }
      box.style.overflow = "hidden";
      glide = box.animate([{ height: `${from}px` }, { height: `${next}px` }], GLIDE);
      glide.onfinish = settle;
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      glide?.cancel();
    };
  }, []);

  return (
    <div ref={outer}>
      <div ref={inner}>{children}</div>
    </div>
  );
}
