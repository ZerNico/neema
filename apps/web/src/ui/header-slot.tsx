import { createContext, use, useCallback, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const SlotContext = createContext<{
  target: HTMLElement | null;
  setTarget: (element: HTMLElement | null) => void;
} | null>(null);

/**
 * Lets a route put its own context in the app header. The header is rendered by
 * the layout, above the route, so the route reaches it through a portal.
 */
export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const value = useMemo(() => ({ target, setTarget }), [target]);
  return <SlotContext value={value}>{children}</SlotContext>;
}

/** Where route content lands; it takes the header's free width. */
export function HeaderSlot() {
  const setTarget = use(SlotContext)?.setTarget;
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      setTarget?.(element);
      if (!element) return;
      // Where the slot would start with no offset: the stylesheet pushes it to
      // the page's edge while the desktop sidebar is open, never over the buttons.
      const measure = () => {
        const previous = element.previousElementSibling;
        const gap = Number.parseFloat(getComputedStyle(element.parentElement ?? element).columnGap);
        const start = previous
          ? previous.getBoundingClientRect().right + (Number.isNaN(gap) ? 0 : gap)
          : element.getBoundingClientRect().left;
        element.style.setProperty("--header-slot-start", `${start}px`);
      };
      measure();
      // A control appearing beside it, or the window resizing, changes the slot's
      // width; its own offset does too, but leaves the measurement as it was.
      const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
      observer?.observe(element);
      return () => observer?.disconnect();
    },
    [setTarget],
  );
  // The extra margin matches the visual gap between the icon buttons before it,
  // whose glyphs sit inset in their boxes while text starts at its edge.
  return <div ref={attach} data-header-slot="" className="ml-2 flex min-w-0 flex-1 items-center" />;
}

export function HeaderContent({ children }: { children: ReactNode }) {
  const target = use(SlotContext)?.target;
  return target ? createPortal(children, target) : null;
}
