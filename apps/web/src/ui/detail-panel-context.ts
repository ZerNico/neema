import { createContext, useContext, useEffect } from "react";
import type {
  DetailPanelApi,
  DetailPanelRequest,
  DetailPanelTabSummary,
} from "~/ui/detail-panel-state.ts";

export interface TabsView {
  tabs: ReadonlyArray<DetailPanelTabSummary>;
  activeId: string | null;
  visible: boolean;
}

/**
 * Actions are split from state so that opening or closing the panel doesn't
 * re-render every consumer that only ever calls open(), i.e. every message.
 */
export const DetailPanelContext = createContext<DetailPanelApi | null>(null);
export const DetailPanelStateContext = createContext<DetailPanelRequest | null>(null);
/**
 * Live owners subscribe to identity, not the request they refresh: updating a
 * body must not trigger another owner render and refresh feedback loop.
 */
export const DetailPanelSelectedIdContext = createContext<string | null>(null);
export const DetailPanelTabsContext = createContext<TabsView>({
  tabs: [],
  activeId: null,
  visible: false,
});
/**
 * Only changes when a tab is added or removed, so owners can follow their tabs
 * without re-rendering on every title or subtitle refresh.
 */
export const DetailPanelTabIdsContext = createContext<ReadonlyArray<string>>([]);
export const DetailPanelRouteContext = createContext("");
export const DetailPanelAvailableContext = createContext(true);
export type PanelAction = { type: "open"; id: string } | { type: "close"; id?: string };
/**
 * Desktop focus is handed off synchronously, before React makes outgoing content
 * inert. Mobile deliberately leaves focus management entirely to Base UI.
 */
export const DetailPanelBeforeActionContext = createContext<
  (handler: (action: PanelAction) => void) => () => void
>(() => () => {});

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
