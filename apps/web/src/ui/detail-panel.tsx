import {
  Cancel01Icon,
  File01Icon,
  PanelRightCloseIcon,
  PanelRightIcon,
  PanelRightOpenIcon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { RestrictToHorizontalAxis } from "@dnd-kit/abstract/modifiers";
import { RestrictToElement } from "@dnd-kit/dom/modifiers";
import { DragDropProvider, PointerSensor } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
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
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { PanelTitlebar } from "~/ui/desktop-chrome.tsx";
import {
  DETAIL_PANEL_MIN,
  DETAIL_PANEL_STEP,
  detailPanelMax,
  useDetailPanelWidth,
} from "~/ui/detail-panel-width.ts";
import { readPanelScope, writePanelScope, type StoredPanelScope } from "~/ui/detail-panel-tabs.ts";
import { MotionSwap, useAppReducedMotion } from "~/ui/motion";
import { EmptyState, ListSkeleton } from "~/ui/page-shell.tsx";
import { Button } from "~/ui/primitives/button";
import { Spinner } from "~/ui/primitives/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/ui/primitives/tooltip";
import { useIsMobile } from "~/ui/use-mobile";
import { cn } from "~/ui/utils";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    /** `false` keeps the panel off a page, toggle included. */
    detailPanel?: false;
  }
}

export interface DetailPanelRequest {
  /** Identity of the content. Refreshing the same id preserves body state. */
  id: string;
  title: string;
  /** Snapshotted like the body; live owners refresh both after committing data. */
  subtitle?: ReactNode;
  /**
   * Pinned under the tab strip, outside the scroller. The shell owns this
   * region so a body never has to position itself against padding it does not
   * control.
   */
  actions?: ReactNode;
  /** Props are snapshotted at open time, then updated by re-open or refresh. */
  body: ReactNode;
  /** Shown in the tab strip; a generic file otherwise. */
  icon?: IconSvgElement;
  /** An image in place of `icon`, such as a page's favicon as a `data:` URL. */
  iconSrc?: string;
  /** The tab shows a spinner in place of its icon, as a browser tab does while loading. */
  busy?: boolean;
  /**
   * The tab outlives navigation and restarts. Only for content an owner can
   * rebuild from the id and `data`: until it refreshes, the tab shows a pending body.
   */
  restorable?: boolean;
  /** Small strings stored with a restorable tab, such as a browser tab's address. */
  data?: Readonly<Record<string, string>>;
  /** The body takes the whole area, unpadded and unscrolled: a browser page. */
  fill?: boolean;
}

export interface DetailPanelApi {
  /** Adds the tab if it is new, selects it and shows the panel. */
  open: (request: DetailPanelRequest) => void;
  /** Updates the tab with this id wherever it is; never adds, selects or shows one. */
  refresh: (request: DetailPanelRequest) => void;
  select: (id: string) => void;
  /** Removes the tab and selects a neighbour; the panel hides with its last tab. */
  closeTab: (id: string) => void;
  /**
   * The owner unmounted. A restorable tab keeps its place with a pending body,
   * since the same owner may come straight back; any other tab closes.
   */
  release: (id: string) => void;
  /** Keeps every tab, so the header toggle brings them back. */
  hide: () => void;
  /** Shows the panel, on a new tab when it has none. */
  show: () => void;
  newTab: () => void;
  /** Puts `request` where tab `id` is, selected, as a new tab becomes a page. */
  replaceTab: (id: string, request: DetailPanelRequest) => void;
  /** Moves the tab to `index` in the strip, clamped to its ends. */
  moveTab: (id: string, index: number) => void;
}

interface PanelTab {
  id: string;
  title: string;
  icon?: IconSvgElement;
  restorable: boolean;
  data?: Readonly<Record<string, string>>;
  /** Null for a restored tab whose owner has not refreshed it yet. */
  request: DetailPanelRequest | null;
}

interface PanelState {
  scope: string;
  tabs: ReadonlyArray<PanelTab>;
  activeId: string | null;
  visible: boolean;
}

export interface DetailPanelTabSummary {
  id: string;
  title: string;
  icon?: IconSvgElement;
  iconSrc?: string;
  busy?: boolean;
  data?: Readonly<Record<string, string>>;
}

interface TabsView {
  tabs: ReadonlyArray<DetailPanelTabSummary>;
  activeId: string | null;
  visible: boolean;
}

const tabOf = (request: DetailPanelRequest): PanelTab => ({
  id: request.id,
  title: request.title,
  ...(request.icon ? { icon: request.icon } : {}),
  restorable: request.restorable === true,
  ...(request.data ? { data: request.data } : {}),
  request,
});

function withoutTab(state: PanelState, id: string): PanelState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.toSpliced(index, 1);
  if (state.activeId !== id) return { ...state, tabs };
  // Like a browser: the tab to the right takes its place, else the one before.
  const next = tabs[index] ?? tabs[index - 1];
  return next
    ? { ...state, tabs, activeId: next.id }
    : { ...state, tabs, activeId: null, visible: false };
}

function restoredState(userId: string | undefined, scope: string, mobile: boolean): PanelState {
  const stored = userId ? readPanelScope(userId, scope) : null;
  const tabs = (stored?.tabs ?? []).map(({ id, title, data }): PanelTab => {
    const tab: PanelTab = { id, title, restorable: true, request: null };
    if (data) tab.data = data;
    return tab;
  });
  const first = tabs[0];
  if (!stored || !first) return { scope, tabs: [], activeId: null, visible: false };
  return {
    scope,
    tabs,
    activeId: tabs.some((tab) => tab.id === stored.activeId) ? stored.activeId : first.id,
    // A phone shows the panel over the page, so never by itself.
    visible: stored.visible && !mobile,
  };
}

function storedScope(state: PanelState): StoredPanelScope | null {
  const tabs = state.tabs
    .filter((tab) => tab.restorable)
    .map(({ id, title, data }) => (data ? { id, title, data } : { id, title }));
  if (tabs.length === 0) return null;
  return {
    tabs,
    activeId: tabs.some((tab) => tab.id === state.activeId) ? state.activeId : null,
    visible: state.visible,
  };
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
  const available = Boolean(
    useRouterState({
      select: (s) => s.matches[s.matches.length - 1]?.staticData?.detailPanel !== false,
    }),
  );
  const mobile = useIsMobile();
  const [state, setState] = useState(() => restoredState(userId, scope, mobile));
  // Derived during render, so no effect is needed and the previous page's tabs
  // never render against the new one.
  if (state.scope !== scope) setState(restoredState(userId, scope, mobile));

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
    // Content opens beside what it came from; a new tab goes last, as in a browser.
    const open = (request: DetailPanelRequest, last = false) => {
      before({ type: "open", id: request.id });
      setState((current) => {
        const index = current.tabs.findIndex((tab) => tab.id === request.id);
        const active = current.tabs.findIndex((tab) => tab.id === current.activeId);
        const tabs =
          index >= 0
            ? current.tabs.with(index, tabOf(request))
            : current.tabs.toSpliced(
                last || active < 0 ? current.tabs.length : active + 1,
                0,
                tabOf(request),
              );
        return { ...current, tabs, activeId: request.id, visible: true };
      });
    };
    return {
      open: (request) => open(request),
      refresh: (request) =>
        setState((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === request.id);
          return index < 0
            ? current
            : { ...current, tabs: current.tabs.with(index, tabOf(request)) };
        }),
      select: (id) => {
        before({ type: "open", id });
        setState((current) =>
          current.tabs.some((tab) => tab.id === id)
            ? { ...current, activeId: id, visible: true }
            : current,
        );
      },
      closeTab: (id) => {
        before({ type: "close", id });
        setState((current) => withoutTab(current, id));
      },
      release: (id) => {
        before({ type: "close", id });
        setState((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === id);
          const tab = current.tabs[index];
          if (!tab) return current;
          if (!tab.restorable) return withoutTab(current, id);
          return { ...current, tabs: current.tabs.with(index, { ...tab, request: null }) };
        });
      },
      hide: () => {
        before({ type: "close" });
        setState((current) => (current.visible ? { ...current, visible: false } : current));
      },
      show: () =>
        setState((current) => {
          if (current.visible) return current;
          if (current.tabs.length === 0) {
            const tab = tabOf(newTabRequest(newTab));
            return { ...current, tabs: [tab], activeId: tab.id, visible: true };
          }
          const activeId = current.tabs.some((tab) => tab.id === current.activeId)
            ? current.activeId
            : (current.tabs[0]?.id ?? null);
          return { ...current, activeId, visible: true };
        }),
      newTab: () => open(newTabRequest(newTab), true),
      replaceTab: (id, request) => {
        before({ type: "open", id: request.id });
        setState((current) => {
          const index = current.tabs.findIndex((tab) => tab.id === id);
          if (index < 0) return current;
          const tabs = current.tabs
            .with(index, tabOf(request))
            .filter((tab, position) => position === index || tab.id !== request.id);
          return { ...current, tabs, activeId: request.id, visible: true };
        });
      },
      moveTab: (id, index) =>
        setState((current) => {
          const from = current.tabs.findIndex((tab) => tab.id === id);
          const tab = current.tabs[from];
          const to = Math.min(Math.max(index, 0), current.tabs.length - 1);
          if (!tab || from === to) return current;
          return { ...current, tabs: current.tabs.toSpliced(from, 1).toSpliced(to, 0, tab) };
        }),
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
      tabs: state.tabs.map(({ id, title, icon, data, request }) => {
        const summary: DetailPanelTabSummary = { id, title };
        if (icon) summary.icon = icon;
        if (data) summary.data = data;
        if (request?.iconSrc) summary.iconSrc = request.iconSrc;
        if (request?.busy) summary.busy = true;
        return summary;
      }),
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

// dnd-kit will not start a drag from a button inside the dragged element, and a
// tab is mostly its button. Only the close button keeps a press to itself.
const TAB_SENSORS = [
  PointerSensor.configure({
    preventActivation: (event) =>
      event.target instanceof Element && event.target.closest("[data-tab-close]") !== null,
  }),
];

// Along the strip only, and never past either end of the tab list.
const TAB_MODIFIERS = [
  RestrictToHorizontalAxis,
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest("[role=tablist]") ?? null,
  }),
];

/**
 * One button per tab, with roving focus: Tab enters on the selected one, arrows
 * move and select, Alt+Shift+arrows move the tab itself. Dragging sorts with
 * dnd-kit, whose other tabs slide aside as one passes them; its keyboard sensor
 * is left out because it would take Enter and Space, which select a tab.
 */
function DetailPanelTabStrip({ ids }: { ids: { tab: (index: number) => string; panel: string } }) {
  const panel = useDetailPanel();
  const { tabs, activeId, visible } = useContext(DetailPanelTabsContext);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const tab = tabs[index];
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (tab && step !== 0 && event.altKey && event.shiftKey) {
      event.preventDefault();
      panel.moveTab(tab.id, index + step);
      return;
    }
    const target =
      step !== 0
        ? tabs[(index + step + tabs.length) % tabs.length]
        : event.key === "Home"
          ? tabs[0]
          : event.key === "End"
            ? tabs.at(-1)
            : undefined;
    if (!target) return;
    event.preventDefault();
    panel.select(target.id);
    buttons.current.get(target.id)?.focus();
  };
  const reducedMotion = useAppReducedMotion();
  // A tab opened or selected past the strip's edge is scrolled into view, as a
  // browser does; the strip only scrolls sideways, so nothing else moves.
  useEffect(() => {
    if (!visible || activeId === null) return;
    buttons.current.get(activeId)?.parentElement?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: reducedMotion ? "auto" : "smooth",
    });
  }, [activeId, visible, reducedMotion]);
  const register = useCallback((id: string, element: HTMLButtonElement | null) => {
    if (element) buttons.current.set(id, element);
    else buttons.current.delete(id);
  }, []);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <DragDropProvider
        sensors={TAB_SENSORS}
        modifiers={TAB_MODIFIERS}
        onDragEnd={(event) => {
          const { source } = event.operation;
          if (event.canceled || !isSortable(source)) return;
          if (source.index !== source.initialIndex) panel.moveTab(String(source.id), source.index);
        }}
      >
        <div
          role="tablist"
          aria-label="Panel tabs"
          className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
          // The strip only scrolls sideways, so a plain wheel scrolls it sideways.
          onWheel={(event) => {
            if (Math.abs(event.deltaY) > Math.abs(event.deltaX))
              event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {tabs.map((tab, index) => (
            <PanelTab
              key={tab.id}
              tab={tab}
              index={index}
              id={ids.tab(index)}
              panelId={ids.panel}
              selected={visible && tab.id === activeId}
              focusable={visible ? tab.id === activeId : index === 0}
              register={register}
              onKeyDown={onKeyDown}
            />
          ))}
        </div>
      </DragDropProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={panel.newTab}
              aria-label="New tab"
              className="text-muted-foreground"
            />
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </TooltipTrigger>
        <TooltipContent>New tab</TooltipContent>
      </Tooltip>
    </div>
  );
}

function PanelTab({
  tab,
  index,
  id,
  panelId,
  selected,
  focusable,
  register,
  onKeyDown,
}: {
  tab: DetailPanelTabSummary;
  index: number;
  id: string;
  panelId: string;
  selected: boolean;
  focusable: boolean;
  register: (id: string, element: HTMLButtonElement | null) => void;
  onKeyDown: (event: KeyboardEvent, index: number) => void;
}) {
  const panel = useDetailPanel();
  const { ref, isDragging } = useSortable({ id: tab.id, index });
  return (
    <div
      ref={ref}
      data-panel-tab=""
      className={cn(
        // The ring is inset: the strip scrolls sideways, which clips anything
        // drawn outside a tab.
        "group/tab ring-ring/50 flex h-8 max-w-48 min-w-0 shrink-0 items-center gap-0.5 rounded-md pr-0.5 ring-inset transition-colors has-[[role=tab]:focus-visible]:ring-2",
        selected
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
        isDragging && "bg-muted text-foreground shadow-sm",
      )}
    >
      <button
        type="button"
        role="tab"
        id={id}
        aria-selected={selected}
        {...(selected ? { "aria-controls": panelId } : {})}
        tabIndex={focusable ? 0 : -1}
        ref={(element) => {
          register(tab.id, element);
          return () => register(tab.id, null);
        }}
        className="flex h-full min-w-0 items-center gap-1.5 pl-2 text-sm outline-none"
        onClick={() => panel.select(tab.id)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          panel.closeTab(tab.id);
        }}
        onKeyDown={(event) => onKeyDown(event, index)}
      >
        {tab.busy ? (
          <Spinner aria-hidden className="size-4 shrink-0" />
        ) : tab.iconSrc ? (
          <img src={tab.iconSrc} alt="" className="size-4 shrink-0 rounded-sm" />
        ) : (
          <HugeiconsIcon
            icon={tab.icon ?? File01Icon}
            strokeWidth={2}
            className="size-4 shrink-0"
            aria-hidden
          />
        )}
        <span className="truncate">{tab.title}</span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => panel.closeTab(tab.id)}
        aria-label={`Close ${tab.title}`}
        data-tab-close=""
        className={cn(
          "text-muted-foreground",
          !selected && "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
        )}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
      </Button>
    </div>
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
          <DetailPanelTabStrip ids={ids} />
        </div>
      ) : (
        <PanelTitlebar>
          <DetailPanelTabStrip ids={ids} />
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

/** Every tab on this page with its stored data, for owners restoring theirs. */
export function useDetailPanelTabs(): ReadonlyArray<DetailPanelTabSummary> {
  return useContext(DetailPanelTabsContext).tabs;
}
