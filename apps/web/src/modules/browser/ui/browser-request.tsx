import { Globe02Icon } from "@hugeicons/core-free-icons";
import type { DetailPanelRequest, NewTabContent } from "~/ui/detail-panel.tsx";
import { PanelEmptyState } from "~/ui/detail-panel.tsx";
import { m } from "~/paraglide/messages.js";
import { pageTitle } from "../client/address.ts";
import { BrowserChrome, BrowserSlot, NewTabBar } from "./browser-page.tsx";

/**
 * Panel tab ids of browser pages. Plain values live here, apart from the
 * components, so Fast Refresh can swap those.
 */
export const BROWSER_TAB_PREFIX = "browser:";

/**
 * A browser page as a panel tab, with its address as the stored data. Kept
 * across restarts, and brought back discarded, unless its profile lives in
 * memory (a temporary chat's), which has nothing to come back to.
 */
export function browserTabRequest(
  tab: {
    id: string;
    url: string;
    title: string;
    partition: string;
    label?: string;
    favicon?: string | null;
  },
  busy = false,
): DetailPanelRequest {
  return {
    id: `${BROWSER_TAB_PREFIX}${tab.id}`,
    title: pageTitle(tab.title, tab.url, m.browser_tab_new()),
    icon: Globe02Icon,
    ...(tab.favicon ? { iconSrc: tab.favicon } : {}),
    busy,
    restorable: tab.partition.startsWith("persist:"),
    data: tab.label ? { url: tab.url, label: tab.label } : { url: tab.url },
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
