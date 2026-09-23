import { createContext, use, useMemo, useState, type ReactNode } from "react";
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
  const slot = use(SlotContext);
  return <div ref={slot?.setTarget} className="flex min-w-0 flex-1 items-center" />;
}

export function HeaderContent({ children }: { children: ReactNode }) {
  const target = use(SlotContext)?.target;
  return target ? createPortal(children, target) : null;
}
