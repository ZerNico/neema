import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouterState } from "@tanstack/react-router";
import * as m from "motion/react-m";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  DETAIL_PANEL_MIN,
  DETAIL_PANEL_STEP,
  detailPanelMax,
  useDetailPanelWidth,
} from "~/ui/detail-panel-width.ts";
import { useAppReducedMotion } from "~/ui/motion";
import { Button } from "~/ui/primitives/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "~/ui/primitives/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { useIsMobile } from "~/ui/use-mobile";
import { cn } from "~/ui/utils";

export interface DetailPanelRequest {
  /** Identity of the content. Refreshing the same id preserves body state. */
  id: string;
  title: string;
  /** Snapshotted like the body; live owners refresh both after committing data. */
  subtitle?: ReactNode;
  /**
   * Pinned under the panel header, outside the scroller. The shell owns this
   * region so a body never has to position itself against padding it does not
   * control: the rail and the mobile sheet pad their scrollers differently, and
   * a body sticking itself to the scroll edge can only be right in one of them.
   */
  actions?: ReactNode;
  /** Props are snapshotted at open time, then updated by re-open or refresh. */
  body: ReactNode;
}

export interface DetailPanelApi {
  open: (request: DetailPanelRequest) => void;
  close: () => void;
  /** Update only the currently selected identity; never open or switch a panel. */
  refresh: (request: DetailPanelRequest) => void;
  closeIfSelected: (id: string) => void;
}

// Actions are split from state so that opening or closing the panel doesn't
// re-render every consumer that only ever calls open() — i.e. every message.
const DetailPanelContext = createContext<DetailPanelApi | null>(null);
const DetailPanelStateContext = createContext<DetailPanelRequest | null>(null);
// Live owners subscribe to identity, not the request they refresh: updating a
// body must not trigger another owner render and refresh feedback loop.
const DetailPanelSelectedIdContext = createContext<string | null>(null);
const DetailPanelRouteContext = createContext("");
type PanelAction = { type: "open"; id: string } | { type: "close"; id?: string };
// Desktop focus is handed off synchronously, before React makes outgoing content
// inert. Mobile deliberately leaves focus management entirely to Base UI.
const DetailPanelBeforeActionContext = createContext<
  (handler: (action: PanelAction) => void) => () => void
>(() => () => {});

// A general-purpose detail region beside the main content — the sources list is
// the first tenant, not the only intended one.
//
//   const panel = useDetailPanel()
//   panel.open({ id: `sources:${messageId}`, title: "Sources",
//                body: <SourcesPanelBody … /> })
//
// The provider only supplies context; render <DetailPanelRail /> wherever the
// region belongs in the layout. On desktop the rail is a flex *sibling* of the
// content, so opening it shrinks the content rather than covering it; on mobile
// it becomes a bottom sheet.
export function DetailPanelProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DetailPanelRequest | null>(null);

  const beforeAction = useRef<((action: PanelAction) => void) | null>(null);
  const registerBeforeAction = useCallback((handler: (action: PanelAction) => void) => {
    beforeAction.current = handler;
    return () => {
      if (beforeAction.current === handler) beforeAction.current = null;
    };
  }, []);
  const open = useCallback((request: DetailPanelRequest) => {
    beforeAction.current?.({ type: "open", id: request.id });
    setState(request);
  }, []);
  const close = useCallback(() => {
    beforeAction.current?.({ type: "close" });
    setState(null);
  }, []);
  const refresh = useCallback((request: DetailPanelRequest) => {
    setState((current) => (current?.id === request.id ? request : current));
  }, []);
  const closeIfSelected = useCallback((id: string) => {
    beforeAction.current?.({ type: "close", id });
    setState((current) => (current?.id === id ? null : current));
  }, []);

  // Otherwise navigating away leaves the panel showing the previous page's
  // detail. Derived during render — no effect needed.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setState(null);
  }

  const api = useMemo<DetailPanelApi>(
    () => ({ open, close, refresh, closeIfSelected }),
    [open, close, refresh, closeIfSelected],
  );

  return (
    <DetailPanelContext.Provider value={api}>
      <DetailPanelSelectedIdContext.Provider value={state?.id ?? null}>
        <DetailPanelStateContext.Provider value={state}>
          <DetailPanelBeforeActionContext.Provider value={registerBeforeAction}>
            <DetailPanelRouteContext.Provider value={pathname}>
              {children}
            </DetailPanelRouteContext.Provider>
          </DetailPanelBeforeActionContext.Provider>
        </DetailPanelStateContext.Provider>
      </DetailPanelSelectedIdContext.Provider>
    </DetailPanelContext.Provider>
  );
}

export function DetailPanelRail({ className }: { className?: string }) {
  const pathname = useContext(DetailPanelRouteContext);
  const isMobile = useIsMobile();
  // Neither route changes nor breakpoint changes retain the old host/presence.
  // In particular, navigation must not animate another conversation's body out.
  return isMobile ? (
    <MobilePanel key={pathname} />
  ) : (
    <DesktopPanel key={pathname} className={className} />
  );
}

function usePanelPresentation() {
  const selected = useContext(DetailPanelStateContext);
  const [presentation, setPresentation] = useState({
    selected,
    request: selected,
    generation: 0,
  });
  if (presentation.selected !== selected) {
    setPresentation({
      selected,
      request: selected ?? presentation.request,
      // Refreshes do not restart animation; close/reopen does, even for one ID.
      generation: presentation.generation + (presentation.selected?.id === selected?.id ? 0 : 1),
    });
  }
  const finishExit = useCallback((generation: number) => {
    setPresentation((current) =>
      current.selected === null && current.generation === generation && current.request !== null
        ? { ...current, request: null }
        : current,
    );
  }, []);
  return { ...presentation, open: selected !== null, finishExit };
}

function MobilePanel() {
  const panel = useDetailPanel();
  const { request, open, generation, finishExit } = usePanelPresentation();
  const reducedMotion = useAppReducedMotion();
  return (
    <Sheet
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && panel.close()}
      onOpenChangeComplete={(nextOpen) => !nextOpen && finishExit(generation)}
    >
      <SheetContent
        side="bottom"
        className={cn(
          "detail-panel-sheet max-h-[80svh]",
          reducedMotion && "!transition-none !transform-none !translate-none",
        )}
        aria-hidden={!open || undefined}
        inert={!open || undefined}
      >
        <SheetHeader className="pb-2">
          <SheetTitle>{request?.title}</SheetTitle>
          {request?.subtitle ? (
            <p className="text-muted-foreground text-xs">{request.subtitle}</p>
          ) : null}
        </SheetHeader>
        {request?.actions ? (
          <div className="shrink-0 border-b px-6 pb-3">{request.actions}</div>
        ) : null}
        <div key={request?.id} className="min-h-0 flex-1 overflow-y-auto px-6">
          <div className="py-4">{request?.body}</div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function restorePanelFocus(root: HTMLElement, opener: HTMLElement | null) {
  if (!root.contains(document.activeElement)) return;
  if (opener?.isConnected && !root.contains(opener) && !opener.closest("[inert]")) {
    opener.focus({ preventScroll: true });
    if (!root.contains(document.activeElement)) return;
  }
  const fallback = document.querySelector<HTMLElement>("main, [role=main]") ?? document.body;
  const tabIndex = fallback.getAttribute("tabindex");
  if (tabIndex === null) fallback.setAttribute("tabindex", "-1");
  fallback.focus({ preventScroll: true });
  if (tabIndex === null) fallback.removeAttribute("tabindex");
}

/**
 * The rail's left edge, dragged to resize. Pointer capture keeps the drag alive
 * over the transcript and its iframes, and the same control resizes from the
 * keyboard, since a drag handle nobody can tab to is a control half the people
 * using it cannot reach.
 */
function DetailPanelResizer({
  width,
  onResize,
  onReset,
  onDraggingChange,
}: {
  width: number;
  onResize: (width: number, persist?: boolean) => void;
  onReset: () => void;
  onDraggingChange: (dragging: boolean) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      aria-valuenow={width}
      aria-valuemin={DETAIL_PANEL_MIN}
      aria-valuemax={detailPanelMax(typeof window === "undefined" ? width * 2 : window.innerWidth)}
      tabIndex={0}
      // Sits wholly inside the rail: the shell clips its overflow, so a handle
      // straddling the edge loses its outer half and the cursor with it.
      className={cn(
        "absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize",
        "hover:bg-border focus-visible:bg-ring focus-visible:outline-none",
        "touch-none transition-colors",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        start.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        onDraggingChange(true);
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (!from) return;
        // The rail is on the right, so dragging left widens it.
        onResize(from.width + (from.x - event.clientX), false);
      }}
      onPointerUp={(event) => {
        if (!start.current) return;
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        onDraggingChange(false);
        onResize(width);
      }}
      onLostPointerCapture={() => {
        if (!start.current) return;
        start.current = null;
        onDraggingChange(false);
        onResize(width);
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(width + DETAIL_PANEL_STEP);
        else if (event.key === "ArrowRight") onResize(width - DETAIL_PANEL_STEP);
        else if (event.key === "Home" || event.key === "End") onReset();
        else return;
        event.preventDefault();
      }}
    />
  );
}

function DesktopPanel({ className }: { className: string | undefined }) {
  const panel = useDetailPanel();
  const registerBeforeAction = useContext(DetailPanelBeforeActionContext);
  const { selected, request, open, generation, finishExit } = usePanelPresentation();
  const selectedId = selected?.id;
  const reducedMotion = useAppReducedMotion();
  const { width, resize, reset } = useDetailPanelWidth();
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  // A drag leaves the 8px handle almost immediately, and the cursor follows
  // whatever is under the pointer, so hold it on the document for the duration
  // and stop the transcript selecting text as the pointer sweeps it.
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const cursor = style.cursor;
    const select = style.userSelect;
    style.cursor = "col-resize";
    style.userSelect = "none";
    return () => {
      style.cursor = cursor;
      style.userSelect = select;
    };
  }, [dragging]);

  useLayoutEffect(() => {
    const handleAction = (action: PanelAction) => {
      if (action.type === "open") {
        const active = document.activeElement;
        if (active instanceof HTMLElement && !root.current?.contains(active)) {
          opener.current = active;
        }
        if (selectedId !== action.id && root.current) {
          restorePanelFocus(root.current, opener.current);
        }
      } else if (
        selectedId !== undefined &&
        (action.id === undefined || action.id === selectedId)
      ) {
        if (root.current) restorePanelFocus(root.current, opener.current);
      }
    };
    return registerBeforeAction(handleAction);
  }, [registerBeforeAction, selectedId]);

  // A nonmodal rail owns Escape, but never steals focus from elsewhere on close.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") panel.close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, panel]);

  // A zero-duration exit must not depend on an animation frame/completion event.
  useLayoutEffect(() => {
    if (!open && (reducedMotion || typeof requestAnimationFrame !== "function")) {
      finishExit(generation);
    }
  }, [open, reducedMotion, generation, finishExit]);

  if (!request) return null;
  // The width belongs in the label: Motion re-runs on a changed label, not on a
  // changed variant definition, so a drag would otherwise leave the rail at the
  // width it opened with.
  const target = `${open ? "open" : "closed"}-${generation}-${reducedMotion ? "reduced" : "animated"}-${open ? width : 0}`;
  const duration = reducedMotion ? 0 : 0.2;
  return (
    <m.aside
      ref={root}
      aria-label={request.title}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden",
        !open && "pointer-events-none",
        className,
      )}
      initial={{ width: reducedMotion ? width : 0 }}
      animate={target}
      variants={{ [target]: { width: open ? width : 0 } }}
      // A drag must track the pointer, not ease toward it; the open and close
      // animation keeps its own duration.
      transition={dragging ? { duration: 0 } : { duration, ease: "easeInOut" }}
      onAnimationComplete={(definition) => {
        if (!open && definition === target) finishExit(generation);
      }}
    >
      <m.div
        key={request.id}
        style={{ width }}
        className="relative flex min-h-0 flex-1 flex-col border-l"
        initial={{ opacity: reducedMotion ? 1 : 0, x: reducedMotion ? 0 : 8 }}
        animate={target}
        variants={{ [target]: { opacity: open ? 1 : 0, x: reducedMotion || open ? 0 : 8 } }}
        transition={{ duration: reducedMotion ? 0 : 0.14, ease: "easeOut" }}
      >
        <DetailPanelResizer
          width={width}
          onResize={resize}
          onReset={reset}
          onDraggingChange={setDragging}
        />
        <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{request.title}</p>
          {request.subtitle ? (
            <span className="text-muted-foreground shrink-0 text-xs">{request.subtitle}</span>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={panel.close}
                  aria-label="Close panel"
                  className="text-muted-foreground"
                />
              }
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>Close panel</TooltipContent>
          </Tooltip>
        </div>
        {request.actions ? (
          <div className="shrink-0 border-b px-4 py-3">{request.actions}</div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="py-4">{request.body}</div>
        </div>
      </m.div>
    </m.aside>
  );
}

/** Stable actions — safe to depend on from memo hooks. */
export function useDetailPanel(): DetailPanelApi {
  const api = useContext(DetailPanelContext);
  if (!api) throw new Error("useDetailPanel must be used within a DetailPanelProvider");
  return api;
}

/** Selection-only subscription: body/subtitle refreshes do not notify owners. */
export function useDetailPanelSelectedId(): string | null {
  return useContext(DetailPanelSelectedIdContext);
}
