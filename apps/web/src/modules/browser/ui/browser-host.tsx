import type { DesktopBrowser } from "@chat/desktop-rpc";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDetailPanel } from "~/ui/detail-panel.tsx";
import {
  browserTabs,
  useBrowserTabs,
  type BrowserTab,
  type WebviewElement,
} from "../client/browser-store.ts";
import { planLifecycle } from "../client/lifecycle.ts";
import { useBrowserOwner } from "../client/owner.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";
import { hostOf } from "../client/address.ts";
import { browserTabRequest } from "./browser-request.tsx";

// Frozen and discarded states are re-planned on this beat as well as on every
// change, so a page left unseen freezes without anything else happening.
const REPLAN_MS = 30_000;

const POPUPS = { allowpopups: "true" } as object;

// Hidden until the slot places it; afterwards the store writes the geometry.
const UNPLACED = { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" } as const;

type WebviewEvent = Event & { url?: string; title?: string };

function GuestPage({ tab }: { tab: BrowserTab }) {
  // Only the first address goes in the markup: changing `src` later would
  // reload the page, so navigation goes through the element instead.
  const [src] = useState(tab.url);
  const { id } = tab;
  return (
    <webview
      src={src}
      partition={tab.partition}
      // Popups are refused by the shell and offered back as tabs, but only a
      // guest allowed popups asks at all. React drops a `true` it does not know
      // as an attribute, so the string goes in as one.
      {...POPUPS}
      className="fixed z-30 border-0"
      style={UNPLACED}
      ref={(element: HTMLElement | null) => {
        if (!element) return;
        const webview = element as WebviewElement;
        browserTabs.attach(id, webview);
        const sync = (url?: string) => {
          try {
            const next = url ?? webview.getURL();
            // Like a browser, the old icon stays until the new site names one.
            const moved = hostOf(next) !== hostOf(browserTabs.get(id)?.url ?? "");
            browserTabs.update(id, {
              url: next,
              canGoBack: webview.canGoBack(),
              canGoForward: webview.canGoForward(),
              ...(moved ? { favicon: null } : {}),
            });
          } catch {
            // Before dom-ready the element answers nothing; the next event syncs.
          }
        };
        const listeners: Array<[string, (event: WebviewEvent) => void]> = [
          [
            "dom-ready",
            () => {
              const webContentsId = webview.getWebContentsId();
              if (browserTabs.get(id)?.webContentsId !== webContentsId)
                browserTabs.update(id, { webContentsId, lifecycle: null });
              sync();
            },
          ],
          ["did-start-loading", () => browserTabs.update(id, { loading: true })],
          [
            "did-stop-loading",
            () => {
              browserTabs.update(id, { loading: false });
              sync();
            },
          ],
          ["did-navigate", (event) => sync(event.url)],
          ["did-navigate-in-page", (event) => sync(event.url)],
          ["page-title-updated", (event) => browserTabs.update(id, { title: event.title ?? "" })],
          ["media-started-playing", () => browserTabs.update(id, { audible: true })],
          ["media-paused", () => browserTabs.update(id, { audible: false })],
        ];
        for (const [name, listener] of listeners) webview.addEventListener(name, listener);
        return () => {
          for (const [name, listener] of listeners) webview.removeEventListener(name, listener);
          browserTabs.attach(id, null);
        };
      }}
    />
  );
}

function BrowserLayer({ browser }: { browser: DesktopBrowser }) {
  const tabs = useBrowserTabs();
  const panel = useDetailPanel();
  const screen = useBrowserOwner();
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REPLAN_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const plan = planLifecycle([...tabs.values()], {
      now,
      visible: browserTabs.visible(),
      onScreen: screen,
      held: browserTabs.held(),
    });
    for (const [id, state] of plan) {
      const tab = tabs.get(id);
      if (!tab) continue;
      if (state === "discarded") {
        if (tab.live)
          browserTabs.update(id, {
            live: false,
            webContentsId: null,
            lifecycle: null,
            loading: false,
          });
        continue;
      }
      if (!tab.live) {
        browserTabs.update(id, { live: true });
        continue;
      }
      if (tab.webContentsId === null || tab.lifecycle === state) continue;
      browserTabs.update(id, { lifecycle: state });
      void browser
        .setLifecycle(tab.webContentsId, state)
        .catch(() => browserTabs.update(id, { lifecycle: null }));
    }
  }, [browser, now, screen, tabs]);

  useEffect(
    () =>
      browser.onFavicon(({ webContentsId, dataUrl }) => {
        for (const tab of browserTabs.all().values())
          if (tab.webContentsId === webContentsId) browserTabs.update(tab.id, { favicon: dataUrl });
      }),
    [browser],
  );

  // A popup becomes a tab beside the page that opened it, when that page's owner
  // is on screen; otherwise there is no panel to put it in, so it opens outside.
  useEffect(
    () =>
      browser.onOpenTab(({ webContentsId, url }) => {
        const source = [...browserTabs.all().values()].find(
          (tab) => tab.webContentsId === webContentsId,
        );
        if (!source || source.owner !== screen) {
          void browser.openExternal(url).catch(() => {});
          return;
        }
        const tab = browserTabs.open({
          owner: source.owner,
          partition: source.partition,
          url,
        });
        panel.open(browserTabRequest(tab, source.partition === browser.partition));
      }),
    [browser, panel, screen],
  );

  return createPortal(
    [...tabs.values()].filter((tab) => tab.live).map((tab) => <GuestPage key={tab.id} tab={tab} />),
    document.body,
  );
}

/**
 * Every browser page of every chat, in one layer outside the routes, so a page
 * survives switching chats and panel tabs. Each is laid over its tab's slot;
 * the rest stay alive but hidden until the lifecycle freezes or discards them.
 */
export function BrowserHost() {
  const browser = useDesktopBrowser();
  return browser ? <BrowserLayer browser={browser} /> : null;
}
