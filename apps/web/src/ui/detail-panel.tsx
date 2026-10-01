import {
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useRouterState } from "@tanstack/react-router";
import * as m from "motion/react-m";
import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import { PanelTitlebar } from "~/ui/desktop-chrome.tsx";
import { DetailPanelTabStrip } from "~/ui/detail-panel-strip.tsx";
import {
  DETAIL_PANEL_MIN,
  DETAIL_PANEL_STEP,
  detailPanelMax,
  useDetailPanelWidth,
} from "~/ui/detail-panel-width.ts";
import {
  appendTab,
  closeTab,
  hidePanel,
  moveTab,
  openTab,
  refreshTab,
  releaseTab,
  replaceTab,
  restoredState,
  selectTab,
  showPanel,
  storedScope,
  tabSummary,
  type DetailPanelApi,
  type DetailPanelRequest,
  type DetailPanelTabSummary,
} from "~/ui/detail-panel-state.ts";
import { readPanelScope, writePanelScope, type StoredPanelScope } from "~/ui/detail-panel-tabs.ts";
import { MotionSwap, useAppReducedMotion } from "~/ui/motion";
import { EmptyState, ListSkeleton } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { useIsMobile } from "~/ui/use-mobile";
import { cn } from "~/ui/utils";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** `false` keeps the panel off a page, toggle included. */
    detailPanel?: false;
  }
}

export type {
  DetailPanelApi,
  DetailPanelRequest,
  DetailPanelTabSummary,
} from "~/ui/detail-panel-state.ts";

interface TabsView {
  tabs: ReadonlyArray<DetailPanelTabSummary>;
  activeId: string | null;
  visible: boolean;
}

// Actions are split from state so that opening or closing the panel doesn't
// re-render every consumer that only ever calls open(), i.e. every message.
const DetailPanelContext = createContext<DetailPanelApi | null>(null);
const DetailPanelStateContext = createContext<DetailPanelRequest | null>(null);
// Live owners subscribe to identity, not the request they refresh: updating a
// body must not trigger another owner render and refresh feedback loop.
const DetailPanelSelectedIdContext = createContext<string | null>(null);
const DetailPanelTabsContext = createContext<TabsView>({
  tabs: [],
  activeId: null,
  visible: false,
});
// Only changes when a tab is added or removed, so owners can follow their tabs
// without re-rendering on every title or subtitle refresh.
const DetailPanelTabIdsContext = createContext<ReadonlyArray<string>>([]);
const DetailPanelRouteContext = createContext("");
const DetailPanelAvailableContext = createContext(true);
type PanelAction = { type: "open"; id: string } | { type: "close"; id?: string };
// Desktop focus is handed off synchronously, before React makes outgoing content
// inert. Mobile deliberately leaves focus management entirely to Base UI.
const DetailPanelBeforeActionContext = createContext<
  (handler: (action: PanelAction) => void) => () => void
>(() => () => {});

// A restored tab waits for its owner to rebuild the body from the id.
const PENDING_BODY = <ListSkeleton media="none" />;

/** What a new tab says when it has nothing to offer, here or on a page reusing it. */
export function PanelEmptyState() {
  return (
    <EmptyState
      icon={PanelRightIcon}
      title="Nothing open here yet"
      description="Documents, drafts, research and sources you open show up as tabs."
    />
  );
}

const NEW_TAB_BODY = <PanelEmptyState />;

/** What a page puts in a new tab: the desktop app's address bar, for one. */
export type NewTabContent = (tabId: string) => Pick<DetailPanelRequest, "actions" | "body">;

// A tab of its own, so several can be open; never restorable, since nothing
// but this page could rebuild it.
const newTabRequest = (content: NewTabContent | undefined): DetailPanelRequest => {
  const id = `new-tab:${crypto.randomUUID()}`;
  return { id, title: "New tab", icon: PlusSignIcon, body: NEW_TAB_BODY, ...content?.(id) };
};

/**
 * A tabbed detail region beside the main content (not just for sources).
 *
 *   const panel = useDetailPanel()
 *   panel.open({ id, title, body })
 *
 * The provider supplies context; render <DetailPanelRail /> anywhere in the
 * layout. Desktop's rail is a flex sibling, shrinking content instead of
 * covering it; a phone's covers the page. Each page has its own tabs;
 * restorable ones are remembered per account when `userId` is given.
 * `newTab` fills a new tab, where the desktop app offers an address bar.
 */
export function DetailPanelProvider({
  userId,
  newTab,
  children,
}: {
  userId?: string;
  newTab?: NewTabContent;
  children: ReactNode;
}) {
  // The page on screen, not the location being loaded: while a route is still
  // pending its predecessor stays mounted, and its owners must not see (and
  // prune) the next page's restored tabs.
  const scope = useRouterState({
    select: (s) => s.matches[s.matches.length - 1]?.pathname ?? s.location.pathname,
  });
  // A page can opt out, like the new-chat page: sending navigates away from it,
  // so a tab opened there would be left behind.
  const available = useRouterState({
    select: (s) => s.matches[s.matches.length - 1]?.staticData?.detailPanel !== false,
  });
  const mobile = useIsMobile();
  const restore = () => restoredState(userId ? readPanelScope(userId, scope) : null, scope, mobile);
  const [state, setState] = useState(restore);
  // Derived during render, so no effect is needed and the previous page's tabs
  // never render against the new one.
  if (state.scope !== scope) setState(restore());

  // Serialized so a refresh that changes nothing stored writes nothing; the
  // string is the memo key, and the effect writes what it stands for.
  const stored = useMemo(() => JSON.stringify(storedScope(state)), [state]);
  useEffect(() => {
    if (userId) writePanelScope(userId, state.scope, JSON.parse(stored) as StoredPanelScope | null);
  }, [userId, state.scope, stored]);

  const beforeAction = useRef<((action: PanelAction) => void) | null>(null);
  const registerBeforeAction = useCallback((handler: (action: PanelAction) => void) => {
    beforeAction.current = handler;
    return () => {
      if (beforeAction.current === handler) beforeAction.current = null;
    };
  }, []);

  const api = useMemo<DetailPanelApi>(() => {
    const before = (action: PanelAction) => beforeAction.current?.(action);
    const newTabOf = () => newTabRequest(newTab);
    return {
      open: (request) => {
        before({ type: "open", id: request.id });
        setState((current) => openTab(current, request));
      },
      refresh: (request) => setState((current) => refreshTab(current, request)),
      select: (id) => {
        before({ type: "open", id });
        setState((current) => selectTab(current, id));
      },
      closeTab: (id) => {
        before({ type: "close", id });
        setState((current) => closeTab(current, id));
      },
      release: (id) => {
        before({ type: "close", id });
        setState((current) => releaseTab(current, id));
      },
      hide: () => {
        before({ type: "close" });
        setState(hidePanel);
      },
      show: () => setState((current) => showPanel(current, newTabOf)),
      newTab: () => {
        const request = newTabOf();
        before({ type: "open", id: request.id });
        setState((current) => openTab(current, request, true));
      },
      append: (request) => setState((current) => appendTab(current, request)),
      replaceTab: (id, request) => {
        before({ type: "open", id: request.id });
        setState((current) => replaceTab(current, id, request));
      },
      moveTab: (id, index) => setState((current) => moveTab(current, id, index)),
    };
    // `newTab` is a stable function in practice; a new one rebuilds the actions.
  }, [newTab]);

  const activeTab = state.visible
    ? (state.tabs.find((tab) => tab.id === state.activeId) ?? null)
    : null;
  const selected = useMemo(
    () =>
      activeTab
        ? (activeTab.request ?? { id: activeTab.id, title: activeTab.title, body: PENDING_BODY })
        : null,
    [activeTab],
  );
  const tabsView = useMemo<TabsView>(
    () => ({
      tabs: state.tabs.map(tabSummary),
      activeId: state.activeId,
      visible: state.visible,
    }),
    [state.tabs, state.activeId, state.visible],
  );
  const idsKey = state.tabs.map((tab) => tab.id).join("\n");
  const tabIds = useMemo(() => (idsKey ? idsKey.split("\n") : []), [idsKey]);

  return (
    <DetailPanelContext.Provider value={api}>
      <DetailPanelSelectedIdContext.Provider value={activeTab?.id ?? null}>
        <DetailPanelStateContext.Provider value={selected}>
          <DetailPanelTabsContext.Provider value={tabsView}>
            <DetailPanelTabIdsContext.Provider value={tabIds}>
              <DetailPanelBeforeActionContext.Provider value={registerBeforeAction}>
                <DetailPanelRouteContext.Provider value={state.scope}>
                  <DetailPanelAvailableContext.Provider value={available}>
                    {children}
                  </DetailPanelAvailableContext.Provider>
                </DetailPanelRouteContext.Provider>
              </DetailPanelBeforeActionContext.Provider>
            </DetailPanelTabIdsContext.Provider>
          </DetailPanelTabsContext.Provider>
        </DetailPanelStateContext.Provider>
      </DetailPanelSelectedIdContext.Provider>
    </DetailPanelContext.Provider>
  );
}

export function DetailPanelRail({ className }: { className?: string }) {
  const pathname = useContext(DetailPanelRouteContext);
  const available = useContext(DetailPanelAvailableContext);
  const isMobile = useIsMobile();
  if (!available) return null;
  // Neither route changes nor breakpoint changes retain the old host/presence.
  // In particular, navigation must not animate another conversation's body out.
  return <PanelRail key={`${pathname}\n${isMobile}`} overlay={isMobile} className={className} />;
}

/**
 * The panel's one switch. It never moves: the layout pins it to the top right
 * corner, and both the header and the open panel's strip leave room for it
 * with `PanelToggleSpace`, so showing and hiding never relocate the control.
 */
export function DetailPanelToggle() {
  const panel = useDetailPanel();
  const { tabs, visible } = useContext(DetailPanelTabsContext);
  const available = useContext(DetailPanelAvailableContext);
  if (!available) return null;
  const label = visible
    ? "Hide panel"
    : tabs.length > 1
      ? `Show panel (${tabs.length} tabs)`
      : "Show panel";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={visible ? panel.hide : panel.show}
            aria-label={label}
            aria-expanded={visible}
            className="text-muted-foreground"
          />
        }
      >
        <MotionSwap value={visible ? "hide" : "show"} kind="icon" className="size-4">
          <HugeiconsIcon
            icon={visible ? PanelRightCloseIcon : PanelRightOpenIcon}
            strokeWidth={2}
          />
        </MotionSwap>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Room for the corner toggle at the end of a row it would otherwise cover. The
 * header only needs it while the toggle is over the header: with the rail open
 * beside the page it sits over the rail's strip instead, and on a phone it
 * always stays in the header, above the overlay.
 */
export function PanelToggleSpace({ inHeader = false }: { inHeader?: boolean }) {
  const { visible } = useContext(DetailPanelTabsContext);
  const available = useContext(DetailPanelAvailableContext);
  const mobile = useIsMobile();
  const collapsed = !available || (inHeader && visible && !mobile);
  // Animated with the rail's own 0.2s: the header shrinks with the rail, and a
  // gap vanishing at once would make everything right of it jump. The negative
  // margin takes back the row's gap along with the room.
  return (
    <span
      aria-hidden
      data-collapsed={collapsed || undefined}
      className={cn(
        "shrink-0 transition-[width,margin] duration-200 ease-in-out motion-reduce:transition-none",
        collapsed ? "-ml-2 w-0" : "w-10",
      )}
    />
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

function TabStrip({ ids }: { ids: { tab: (index: number) => string; panel: string } }) {
  return (
    <DetailPanelTabStrip
      panel={useDetailPanel()}
      view={useContext(DetailPanelTabsContext)}
      ids={ids}
    />
  );
}

function useTabIds() {
  const base = useId();
  const { tabs, activeId } = useContext(DetailPanelTabsContext);
  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  return {
    tab: (index: number) => `${base}-tab-${index}`,
    panel: `${base}-panel`,
    activeTab: activeIndex < 0 ? undefined : `${base}-tab-${activeIndex}`,
  };
}

function PanelInfo({
  request,
  className,
}: {
  request: DetailPanelRequest | null;
  className: string;
}) {
  if (!request || (!request.subtitle && !request.actions)) return null;
  return (
    <div className={cn("flex shrink-0 flex-col gap-2 border-b", className)}>
      {request.subtitle ? (
        <p className="text-muted-foreground text-xs wrap-anywhere">{request.subtitle}</p>
      ) : null}
      {request.actions}
    </div>
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
  dragging,
  onResize,
  onReset,
  onDraggingChange,
}: {
  width: number;
  dragging: boolean;
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
      // A grabbable strip that draws nothing itself: the rail already has a
      // border there, so the only mark is the line below, tinting that edge.
      // Sits wholly inside the rail, whose overflow is clipped, or it would
      // lose its outer half and the cursor with it.
      className="group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none focus-visible:outline-none"
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
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0 w-0.5 transition-colors",
          dragging ? "bg-primary" : "bg-transparent group-hover:bg-primary/60",
          "group-focus-visible:bg-primary",
        )}
      />
    </div>
  );
}

/**
 * Publishes the rail's live width for the desktop titlebar, which sits outside
 * this tree: the header ends and the tab strip starts at the rail's edge, and
 * both have to follow it through the open and close animation, not jump to it.
 */
function useTitlebarInset(root: RefObject<HTMLElement | null>, mounted: boolean) {
  useLayoutEffect(() => {
    const element = root.current;
    if (!mounted || !element) return;
    const html = document.documentElement;
    const apply = () => {
      const width = element.getBoundingClientRect().width;
      html.style.setProperty("--detail-panel-inset", `${width}px`);
      if (width > 0) html.dataset.detailPanel = "";
      else delete html.dataset.detailPanel;
    };
    apply();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(apply) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      html.style.removeProperty("--detail-panel-inset");
      delete html.dataset.detailPanel;
    };
  }, [root, mounted]);
}

/**
 * Beside the page on a wide screen, with a draggable edge. On a narrow one the
 * same rail covers the page below the header and slides in from the right, so
 * the corner toggle and its right-panel icon mean the same thing everywhere.
 */
function PanelRail({ className, overlay }: { className: string | undefined; overlay: boolean }) {
  const panel = useDetailPanel();
  const registerBeforeAction = useContext(DetailPanelBeforeActionContext);
  const { selected, request, open, generation, finishExit } = usePanelPresentation();
  const selectedId = selected?.id;
  const reducedMotion = useAppReducedMotion();
  const { width, resize, reset } = useDetailPanelWidth();
  const [dragging, setDragging] = useState(false);
  const root = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ids = useTabIds();
  // A panel already open when the page appears was restored, not opened: it is
  // simply there, as leaving a page simply removes it. Only opening animates.
  const [arrived, setArrived] = useState(open);
  if (arrived && !open) setArrived(false);
  const still = reducedMotion || arrived;
  // An overlay leaves the header where it is, so it publishes no inset.
  useTitlebarInset(root, request !== null && !overlay);

  // A drag leaves the 8px handle almost immediately, so hold the cursor on the
  // document and stop text selection while it lasts. Embedded pages ignore the
  // pointer meanwhile: pointer capture cannot reach their process.
  useEffect(() => {
    if (!dragging) return;
    const { style } = document.body;
    const cursor = style.cursor;
    const select = style.userSelect;
    style.cursor = "col-resize";
    style.userSelect = "none";
    document.documentElement.dataset.panelResizing = "";
    return () => {
      style.cursor = cursor;
      style.userSelect = select;
      delete document.documentElement.dataset.panelResizing;
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

  // A nonmodal rail owns Escape, but never steals focus from elsewhere on hide.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") panel.hide();
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
  const target = `${open ? "open" : "closed"}-${generation}-${reducedMotion ? "reduced" : "animated"}-${open && !overlay ? width : 0}`;
  const duration = reducedMotion ? 0 : 0.2;
  const shape = overlay ? { x: open ? "0%" : "100%" } : { width: open ? width : 0 };
  return (
    <m.aside
      ref={root}
      // Things laid over the rail from outside it follow its animation by this.
      data-panel-rail=""
      // Web links clicked here open as panel tabs (`browser/ui/browser-host.tsx`).
      data-web-links="panel"
      aria-label={request.title}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden",
        // Below the header in a browser; a desktop shell's header is in its
        // titlebar, above this row altogether.
        overlay &&
          "bg-background absolute inset-x-0 top-12 bottom-0 z-20 [html[data-desktop-chrome]_&]:top-0",
        !open && "pointer-events-none",
        className,
      )}
      initial={overlay ? { x: still ? "0%" : "100%" } : { width: still ? width : 0 }}
      animate={target}
      variants={{ [target]: shape }}
      // A drag must track the pointer, not ease toward it; the open and close
      // animation keeps its own duration.
      transition={dragging ? { duration: 0 } : { duration, ease: "easeInOut" }}
      onAnimationComplete={(definition) => {
        if (!open && definition === target) finishExit(generation);
      }}
    >
      {overlay ? (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
          <TabStrip ids={ids} />
        </div>
      ) : (
        <PanelTitlebar>
          <TabStrip ids={ids} />
          <PanelToggleSpace />
        </PanelTitlebar>
      )}
      {/* Not keyed by tab: switching tabs swaps the content below at once, and
          only opening the panel runs this entrance. */}
      <m.div
        style={{ width: overlay ? "100%" : width }}
        className={cn("relative flex min-h-0 flex-1 flex-col", !overlay && "border-l")}
        initial={{ opacity: still ? 1 : 0, x: still ? 0 : 8 }}
        animate={target}
        variants={{ [target]: { opacity: open ? 1 : 0, x: reducedMotion || open ? 0 : 8 } }}
        transition={{ duration: reducedMotion ? 0 : 0.14, ease: "easeOut" }}
      >
        {overlay ? null : (
          <DetailPanelResizer
            width={width}
            dragging={dragging}
            onResize={resize}
            onReset={reset}
            onDraggingChange={setDragging}
          />
        )}
        <Fragment key={request.id}>
          <PanelInfo request={request} className="px-4 py-3" />
          <div
            role="tabpanel"
            id={ids.panel}
            {...(ids.activeTab ? { "aria-labelledby": ids.activeTab } : {})}
            className={cn(
              "min-h-0 flex-1",
              // A filling body (a web page, drawn above the panel) leaves the
              // resize handle's strip uncovered, or nothing could grab it.
              request.fill ? cn("flex flex-col", !overlay && "pl-1.5") : "overflow-y-auto px-4",
            )}
          >
            {request.fill ? (
              request.body
            ) : (
              // A column at least as tall as the scroller, so a body that wants
              // the whole height (an editor) can grow into it with flex-1.
              <div className="flex min-h-full flex-col py-4">{request.body}</div>
            )}
          </div>
        </Fragment>
      </m.div>
    </m.aside>
  );
}

/** Stable actions, safe to depend on from memo hooks. */
export function useDetailPanel(): DetailPanelApi {
  const api = useContext(DetailPanelContext);
  if (!api) throw new Error("useDetailPanel must be used within a DetailPanelProvider");
  return api;
}

/** Selection-only subscription: body/subtitle refreshes do not notify owners. */
export function useDetailPanelSelectedId(): string | null {
  return useContext(DetailPanelSelectedIdContext);
}

/** Every tab on this page, selected or not; changes only when one opens or closes. */
export function useDetailPanelTabIds(): ReadonlyArray<string> {
  return useContext(DetailPanelTabIdsContext);
}

/**
 * Closes this prefix's tabs whose item is no longer in `liveIds`. The page that
 * owns a kind is the only one that can prove an item gone, and a restored tab
 * has nobody else to close it.
 */
export function useDetailPanelReconciler(prefix: string, liveIds: ReadonlyArray<string>) {
  const panel = useDetailPanel();
  const tabIds = useDetailPanelTabIds();
  useEffect(() => {
    const live = new Set(liveIds);
    for (const id of tabIds)
      if (id.startsWith(prefix) && !live.has(id.slice(prefix.length))) panel.closeTab(id);
  }, [panel, prefix, liveIds, tabIds]);
}

/**
 * Keeps one tab current from the page's own data, open or not, so a restored
 * tab gets its body back; null means its item is gone, which closes it. For
 * owners that render one of these per tab of their kind.
 */
export function useDetailPanelTabContent(id: string, request: DetailPanelRequest | null) {
  const panel = useDetailPanel();
  useEffect(() => {
    if (request) panel.refresh(request);
    else panel.closeTab(id);
  }, [panel, id, request]);
}

/** Whether the page on screen has a panel at all (the new-chat page does not). */
export function useDetailPanelAvailable(): boolean {
  return useContext(DetailPanelAvailableContext);
}

/** Every tab on this page with its stored data, for owners restoring theirs. */
export function useDetailPanelTabs(): ReadonlyArray<DetailPanelTabSummary> {
  return useContext(DetailPanelTabsContext).tabs;
}
