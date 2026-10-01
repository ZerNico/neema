import type { DesktopBrowser } from "@chat/desktop-rpc";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useDetailPanel, useDetailPanelAvailable } from "~/ui/detail-panel.tsx";
import {
  browserTabs,
  useBrowserOwners,
  useBrowserTabs,
  type BrowserTab,
  type WebviewElement,
} from "../client/browser-store.ts";
import { planLifecycle } from "../client/lifecycle.ts";
import { useBrowserOwner } from "../client/owner.ts";
import { useDesktopBrowser } from "../client/use-desktop-browser.ts";
import { hostOf } from "../client/address.ts";
import { useLinkTarget } from "../client/search-engine.ts";
import { noteLinkClick, setLinkOpener } from "~/ui/link-opener.ts";
import { browserTabRequest } from "./browser-request.tsx";

// Frozen and discarded states are re-planned on this beat as well as on every
// change, so a page left unseen freezes without anything else happening.
const REPLAN_MS = 30_000;

const POPUPS = { allowpopups: "true" } as object;

// Hidden until the slot places it; afterwards the store writes the geometry.
const UNPLACED = { left: 0, top: 0, width: 0, height: 0, visibility: "hidden" } as const;
// Overlays on a page (link status, working frame): the store places them.
const OVERLAY_UNPLACED = { left: 0, top: 0, visibility: "hidden" } as const;

type WebviewEvent = Event & { url?: string; title?: string };

function GuestPage({ tab }: { tab: BrowserTab }) {
  // Only the first address goes in the markup: changing `src` later would
  // reload the page, so navigation goes through the element instead.
  const [src] = useState(tab.url);
  // The link under the pointer, shown at the page's corner as a browser does.
  const [hovered, setHovered] = useState("");
  const { id } = tab;
  return (
    <>
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
            ["update-target-url", (event) => setHovered(event.url ?? "")],
          ];
          for (const [name, listener] of listeners) webview.addEventListener(name, listener);
          return () => {
            for (const [name, listener] of listeners) webview.removeEventListener(name, listener);
            browserTabs.attach(id, null);
          };
        }}
      />
      {tab.usedBy ? (
        <div
          aria-hidden
          // Over the page, so all four sides show; it takes no pointer.
          className="border-primary pointer-events-none fixed z-40 border-2"
          style={OVERLAY_UNPLACED}
          ref={(element) => {
            browserTabs.attachFrame(id, element);
            return () => browserTabs.attachFrame(id, null);
          }}
        />
      ) : null}
      {hovered ? (
        <div
          aria-hidden
          className="bg-popover text-muted-foreground pointer-events-none fixed z-40 -translate-y-full truncate rounded-tr-md border-t border-r px-2 py-0.5 text-xs"
          style={OVERLAY_UNPLACED}
          ref={(element) => {
            browserTabs.attachStatus(id, element);
            return () => browserTabs.attachStatus(id, null);
          }}
        >
          {hovered}
        </div>
      ) : null}
    </>
  );
}

function BrowserLayer({ browser }: { browser: DesktopBrowser }) {
  const tabs = useBrowserTabs();
  const { held } = useBrowserOwners();
  const panel = useDetailPanel();
  const available = useDetailPanelAvailable();
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
      held,
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
  }, [browser, now, screen, tabs, held]);

  useEffect(
    () =>
      browser.onFavicon(({ webContentsId, dataUrl }) => {
        for (const tab of browserTabs.all().values())
          if (tab.webContentsId === webContentsId) browserTabs.update(tab.id, { favicon: dataUrl });
      }),
    [browser],
  );

  // A web link clicked in the conversation or the panel opens as a tab of the
  // chat on screen, where the panel shows its real address. The setting can make
  // the computer's browser the default instead; ⌘ or Ctrl asks for the other.
  const [linkTarget] = useLinkTarget();
  useEffect(() => {
    if (!available) return;
    const openInPanel = (url: string) => {
      const tab = browserTabs.open({
        owner: screen,
        partition: browserTabs.partitionFor(browser, screen),
        url,
      });
      panel.open(browserTabRequest(tab));
    };
    // Rendered markdown opens its links after asking (`~/ui/link-safety.tsx`),
    // so the choice is registered for it, and each click's modifier noted.
    setLinkOpener({ open: openInPanel, byDefault: linkTarget === "panel" });
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.shiftKey || event.altKey) return;
      if (event.target instanceof Element && event.target.closest('[data-web-links="panel"]'))
        noteLinkClick(event.metaKey || event.ctrlKey);
      if ((linkTarget === "panel") === (event.metaKey || event.ctrlKey)) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      if (!anchor.closest('[data-web-links="panel"]')) return;
      const url = anchor.href;
      if (hostOf(url) === null || new URL(url).origin === window.location.origin) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openInPanel(url);
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      setLinkOpener(null);
    };
  }, [available, browser, linkTarget, panel, screen]);

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
        panel.open(browserTabRequest(tab));
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
