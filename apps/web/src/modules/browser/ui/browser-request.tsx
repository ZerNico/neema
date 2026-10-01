import { Globe02Icon } from "@hugeicons/core-free-icons";
import type { DetailPanelRequest, NewTabContent } from "~/ui/detail-panel.tsx";
import { PanelEmptyState } from "~/ui/detail-panel.tsx";
import { hostOf } from "../client/address.ts";
import { BrowserChrome, BrowserSlot, NewTabBar } from "./browser-page.tsx";

/**
 * Panel tab ids of browser pages. Plain values live here, apart from the
 * components, so Fast Refresh can swap those.
 */
export const BROWSER_TAB_PREFIX = "browser:";

/**
 * A browser page as a panel tab. Restorable unless its chat is temporary, with
 * the address as its stored data, so a restart brings the tab back discarded
 * and it loads again when shown.
 */
export function browserTabRequest(
  tab: { id: string; url: string; title: string; favicon?: string | null },
  restorable: boolean,
  busy = false,
): DetailPanelRequest {
  return {
    id: `${BROWSER_TAB_PREFIX}${tab.id}`,
    title: tab.title || hostOf(tab.url) || "New tab",
    icon: Globe02Icon,
    ...(tab.favicon ? { iconSrc: tab.favicon } : {}),
    busy,
    restorable,
    data: { url: tab.url },
    fill: true,
    actions: <BrowserChrome id={tab.id} />,
    body: <BrowserSlot id={tab.id} />,
  };
}

/** A new tab in the desktop app: the address bar, ready to type into. */
export const browserNewTab: NewTabContent = (tabId) => ({
  actions: <NewTabBar tabId={tabId} toRequest={browserTabRequest} />,
  body: <PanelEmptyState />,
});
