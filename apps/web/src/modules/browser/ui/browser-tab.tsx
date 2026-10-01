import { useEffect, useMemo, useRef } from "react";
import { useDetailPanel, useDetailPanelTabs } from "~/ui/detail-panel.tsx";
import {
  browserTabs,
  useBrowserOwners,
  useBrowserTab,
  useBrowserTabs,
} from "../client/browser-store.ts";
import { useBrowserOwner } from "../client/owner.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";
import { useSettledLoading } from "../client/use-settled-loading.ts";
import { BROWSER_TAB_PREFIX, browserTabRequest } from "./browser-request.tsx";

/** Keeps one browser tab's panel entry in step with its page. */
function BrowserTabOwner({ id }: { id: string }) {
  const panel = useDetailPanel();
  const tab = useBrowserTab(id);
  const url = tab?.url;
  const title = tab?.title;
  const label = tab?.label;
  const favicon = tab?.favicon ?? null;
  const partition = tab?.partition;
  const busy = useSettledLoading(tab?.loading ?? false);
  const request = useMemo(
    () =>
      url === undefined || title === undefined || partition === undefined
        ? null
        : browserTabRequest(
            { id, url, title, partition, favicon, ...(label ? { label } : {}) },
            busy,
          ),
    [id, url, title, label, favicon, partition, busy],
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
 * its browser tabs back from their stored addresses, adds the ones the model
 * opened while it was elsewhere, ends the pages of tabs closed here, shows a
 * tab when the model asks to, and keeps each tab's title, icon and address
 * current. Outside the desktop app there is nothing to show a page in, so
 * restored browser tabs are closed.
 */
export function BrowserPanelOwner() {
  const browser = useDesktopBrowser();
  const panel = useDetailPanel();
  const tabs = useDetailPanelTabs();
  const owner = useBrowserOwner();
  const pages = useBrowserTabs();
  // Subscribed so a chat found temporary restores into its in-memory profile.
  const temporary = useBrowserOwners().temporary.has(owner);
  const mine = useMemo(() => tabs.filter((tab) => tab.id.startsWith(BROWSER_TAB_PREFIX)), [tabs]);
  // This owner's browser tabs on the last pass: one missing since was closed here.
  const seen = useRef<{ owner: string; ids: ReadonlySet<string> } | null>(null);
  // Reveals newer than this follow the model; older ones were for another visit.
  const following = useRef<{ owner: string; since: number } | null>(null);

  // Restoring and adopting are idempotent and pruning cheap, so this simply
  // follows the tabs and the pages.
  useEffect(() => {
    if (!browser) {
      for (const tab of mine) panel.closeTab(tab.id);
      return;
    }
    const partition = temporary ? browser.temporaryPartition(owner) : browser.partition;
    const listed = new Set<string>();
    for (const summary of mine) {
      const id = summary.id.slice(BROWSER_TAB_PREFIX.length);
      listed.add(id);
      browserTabs.restore(id, {
        owner,
        partition,
        url: summary.data?.url ?? "about:blank",
        title: summary.title,
        ...(summary.data?.label ? { label: summary.data.label } : {}),
      });
    }
    const previous = seen.current?.owner === owner ? seen.current.ids : null;
    for (const page of pages.values()) {
      if (page.owner !== owner || listed.has(page.id)) continue;
      // Closed here since the last pass: the page goes with its tab.
      if (previous?.has(page.id)) browserTabs.remove(page.id);
      // Opened by the model while this chat was elsewhere: listed, not selected.
      else {
        panel.append(browserTabRequest(page));
        listed.add(page.id);
      }
    }
    seen.current = { owner, ids: listed };
  }, [browser, owner, mine, pages, panel, temporary]);

  useEffect(() => {
    if (following.current?.owner !== owner) following.current = { owner, since: Date.now() };
    const mark = following.current;
    for (const page of pages.values()) {
      if (page.owner !== owner || page.revealAt <= mark.since) continue;
      mark.since = page.revealAt;
      panel.open(browserTabRequest(page));
    }
  }, [owner, pages, panel]);

  if (!browser) return null;
  return mine.map((tab) => (
    <BrowserTabOwner key={tab.id} id={tab.id.slice(BROWSER_TAB_PREFIX.length)} />
  ));
}
