import { useEffect, useMemo } from "react";
import { useDetailPanel, useDetailPanelTabs } from "~/ui/detail-panel.tsx";
import { browserTabs, useBrowserTab, useBrowserTabs } from "../client/browser-store.ts";
import { useBrowserOwner } from "../client/owner.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";
import { useSettledLoading } from "../client/use-settled-loading.ts";
import { BROWSER_TAB_PREFIX, browserTabRequest } from "./browser-request.tsx";

/** Keeps one browser tab's panel entry in step with its page. */
function BrowserTabOwner({ id, restorable }: { id: string; restorable: boolean }) {
  const panel = useDetailPanel();
  const tab = useBrowserTab(id);
  const url = tab?.url;
  const title = tab?.title;
  const favicon = tab?.favicon ?? null;
  const busy = useSettledLoading(tab?.loading ?? false);
  const request = useMemo(
    () =>
      url === undefined || title === undefined
        ? null
        : browserTabRequest({ id, url, title, favicon }, restorable, busy),
    [id, url, title, favicon, restorable, busy],
  );
  useEffect(() => {
    if (request) panel.refresh(request);
  }, [panel, request]);
  const panelId = `${BROWSER_TAB_PREFIX}${id}`;
  useEffect(() => () => panel.release(panelId), [panel, panelId]);
  return null;
}

/**
 * Mounted once in the layout, for whichever chat or page is on screen. Brings
 * its browser tabs back from their stored addresses, closes the pages of tabs
 * closed meanwhile, and keeps each tab's title, icon and address current.
 * Outside the desktop app there is nothing to show a page in, so restored
 * browser tabs are closed.
 */
export function BrowserPanelOwner() {
  const browser = useDesktopBrowser();
  const panel = useDetailPanel();
  const tabs = useDetailPanelTabs();
  const owner = useBrowserOwner();
  // Subscribed so a chat declaring itself temporary re-renders this owner.
  useBrowserTabs();
  const temporary = browserTabs.isTemporary(owner);
  const mine = useMemo(() => tabs.filter((tab) => tab.id.startsWith(BROWSER_TAB_PREFIX)), [tabs]);

  // Restoring is idempotent and pruning cheap, so this simply follows the tabs.
  useEffect(() => {
    if (!browser) {
      for (const tab of mine) panel.closeTab(tab.id);
      return;
    }
    const partition = temporary ? browser.temporaryPartition(owner) : browser.partition;
    const kept = new Set<string>();
    for (const summary of mine) {
      const id = summary.id.slice(BROWSER_TAB_PREFIX.length);
      kept.add(id);
      browserTabs.restore(id, {
        owner,
        partition,
        url: summary.data?.url ?? "about:blank",
        title: summary.title,
      });
    }
    // A tab closed in the panel ends its page; other owners' pages are untouched.
    for (const tab of browserTabs.all().values())
      if (tab.owner === owner && !kept.has(tab.id)) browserTabs.remove(tab.id);
  }, [browser, owner, mine, panel, temporary]);

  if (!browser) return null;
  return mine.map((tab) => (
    <BrowserTabOwner
      key={tab.id}
      id={tab.id.slice(BROWSER_TAB_PREFIX.length)}
      restorable={!temporary}
    />
  ));
}
