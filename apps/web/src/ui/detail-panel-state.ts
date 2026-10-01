import type { IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";
import type { StoredPanelScope } from "~/ui/detail-panel-tabs.ts";

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
  /** Adds the tab last if it is new, without selecting or showing anything. */
  append: (request: DetailPanelRequest) => void;
  /** Puts `request` where tab `id` is, selected, as a new tab becomes a page. */
  replaceTab: (id: string, request: DetailPanelRequest) => void;
  /** Moves the tab to `index` in the strip, clamped to its ends. */
  moveTab: (id: string, index: number) => void;
}

/**
 * A tab is its request once an owner has given one. A restored tab has only
 * what was stored (title, data) until its owner rebuilds the request.
 */
export interface PanelTab {
  id: string;
  title: string;
  restorable: boolean;
  data?: Readonly<Record<string, string>>;
  request: DetailPanelRequest | null;
}

export interface PanelState {
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

const tabOf = (request: DetailPanelRequest): PanelTab => ({
  id: request.id,
  title: request.title,
  restorable: request.restorable === true,
  ...(request.data ? { data: request.data } : {}),
  request,
});

const indexOf = (state: PanelState, id: string) => state.tabs.findIndex((tab) => tab.id === id);

/** Content opens beside the selected tab; `last` puts it at the end, as a new tab goes. */
export function openTab(state: PanelState, request: DetailPanelRequest, last = false): PanelState {
  const index = indexOf(state, request.id);
  const active = state.activeId === null ? -1 : indexOf(state, state.activeId);
  const tabs =
    index >= 0
      ? state.tabs.with(index, tabOf(request))
      : state.tabs.toSpliced(
          last || active < 0 ? state.tabs.length : active + 1,
          0,
          tabOf(request),
        );
  return { ...state, tabs, activeId: request.id, visible: true };
}

export function refreshTab(state: PanelState, request: DetailPanelRequest): PanelState {
  const index = indexOf(state, request.id);
  return index < 0 ? state : { ...state, tabs: state.tabs.with(index, tabOf(request)) };
}

export function selectTab(state: PanelState, id: string): PanelState {
  return indexOf(state, id) < 0 ? state : { ...state, activeId: id, visible: true };
}

export function closeTab(state: PanelState, id: string): PanelState {
  const index = indexOf(state, id);
  if (index < 0) return state;
  const tabs = state.tabs.toSpliced(index, 1);
  if (state.activeId !== id) return { ...state, tabs };
  // Like a browser: the tab to the right takes its place, else the one before.
  const next = tabs[index] ?? tabs[index - 1];
  return next
    ? { ...state, tabs, activeId: next.id }
    : { ...state, tabs, activeId: null, visible: false };
}

export function releaseTab(state: PanelState, id: string): PanelState {
  const index = indexOf(state, id);
  const tab = state.tabs[index];
  if (!tab) return state;
  if (!tab.restorable) return closeTab(state, id);
  return { ...state, tabs: state.tabs.with(index, { ...tab, request: null }) };
}

export function hidePanel(state: PanelState): PanelState {
  return state.visible ? { ...state, visible: false } : state;
}

/** Shows the panel on its selected tab, or on `newTab` when it has none. */
export function showPanel(state: PanelState, newTab: () => DetailPanelRequest): PanelState {
  if (state.visible) return state;
  if (state.tabs.length === 0) return openTab(state, newTab());
  const activeId =
    state.activeId !== null && indexOf(state, state.activeId) >= 0
      ? state.activeId
      : (state.tabs[0]?.id ?? null);
  return { ...state, activeId, visible: true };
}

export function appendTab(state: PanelState, request: DetailPanelRequest): PanelState {
  return indexOf(state, request.id) >= 0
    ? state
    : { ...state, tabs: [...state.tabs, tabOf(request)] };
}

export function replaceTab(state: PanelState, id: string, request: DetailPanelRequest): PanelState {
  const index = indexOf(state, id);
  if (index < 0) return state;
  const tabs = state.tabs
    .with(index, tabOf(request))
    .filter((tab, position) => position === index || tab.id !== request.id);
  return { ...state, tabs, activeId: request.id, visible: true };
}

export function moveTab(state: PanelState, id: string, index: number): PanelState {
  const from = indexOf(state, id);
  const tab = state.tabs[from];
  const to = Math.min(Math.max(index, 0), state.tabs.length - 1);
  if (!tab || from === to) return state;
  return { ...state, tabs: state.tabs.toSpliced(from, 1).toSpliced(to, 0, tab) };
}

/** A page's tabs as stored, each waiting for its owner to rebuild its body. */
export function restoredState(
  stored: StoredPanelScope | null,
  scope: string,
  mobile: boolean,
): PanelState {
  const tabs = (stored?.tabs ?? []).map(({ id, title, data }) => {
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

export function storedScope(state: PanelState): StoredPanelScope | null {
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

/** What the strip shows of a tab: a restored one has its stored title until refreshed. */
export function tabSummary({ id, title, data, request }: PanelTab): DetailPanelTabSummary {
  return {
    id,
    title,
    ...(request?.icon ? { icon: request.icon } : {}),
    ...(request?.iconSrc ? { iconSrc: request.iconSrc } : {}),
    ...(request?.busy ? { busy: true } : {}),
    ...(data ? { data } : {}),
  };
}
