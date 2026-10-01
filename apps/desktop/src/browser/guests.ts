import {
  clipboard,
  Menu,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { BROWSER_FAVICON, BROWSER_OPEN_TAB, type BrowserLifecycle } from "@chat/desktop-rpc";
import { isSafeExternalUrl } from "../config.ts";
import { faviconDataUrl, inlineFavicon } from "./favicon.ts";
import { admitWebview } from "./guest-policy.ts";
import { isBrowserPartition } from "./partitions.ts";

// Guest pages are arbitrary websites. Clipboard writes keep "copy" buttons
// working; everything else (camera, location, notifications, fonts) is refused.
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
const preparedSessions = new WeakSet<Session>();

// Electron's input events know only left, middle and right, so nothing maps a
// mouse's back and forward buttons to navigation. An isolated-world listener
// does: it shares the page's DOM but none of its scripts.
const NAVIGATION_WORLD = 1001;
const MOUSE_NAVIGATION = `addEventListener("mouseup", (event) => {
  if (event.button !== 3 && event.button !== 4) return;
  event.preventDefault();
  if (event.button === 3) history.back();
  else history.forward();
}, true);`;

// The agent is not set here: guests run on the app-wide default, which main
// keeps to what Electron generates (`user-agent.ts`). Overriding it per profile,
// even with the same string, failed Cloudflare Turnstile once that default differed.
const prepareSession = (profile: Session) => {
  if (preparedSessions.has(profile)) return;
  preparedSessions.add(profile);
  profile.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(ALLOWED_PERMISSIONS.has(permission)),
  );
  profile.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission));
};

const contextMenu = (
  guest: WebContents,
  params: Electron.ContextMenuParams,
): MenuItemConstructorOptions[] => {
  const history = guest.navigationHistory;
  const items: MenuItemConstructorOptions[] = [];
  if (params.linkURL && isSafeExternalUrl(params.linkURL)) {
    items.push(
      { label: "Open Link in Browser", click: () => void shell.openExternal(params.linkURL) },
      { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  if (params.isEditable)
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { type: "separator" });
  else if (params.selectionText) items.push({ role: "copy" }, { type: "separator" });
  items.push(
    { label: "Back", enabled: history.canGoBack(), click: () => history.goBack() },
    { label: "Forward", enabled: history.canGoForward(), click: () => history.goForward() },
    { label: "Reload", click: () => guest.reload() },
  );
  return items;
};

/**
 * The main window's `<webview>` guests: who may create one, how each is
 * hardened, and the pacing the page asks for. `trusted` says whether the window
 * is currently showing the configured server, checked at every attach.
 */
export function attachBrowserGuests(
  window: BrowserWindow,
  profile: string,
  trusted: () => boolean,
) {
  const host = window.webContents;
  const guests = new Set<number>();
  const frozen = new Set<number>();

  host.on("will-attach-webview", (event, preferences, params) => {
    const { partition } = params;
    const admitted =
      trusted() &&
      typeof partition === "string" &&
      admitWebview(params, preferences as Record<string, unknown>, (name) =>
        isBrowserPartition(profile, name),
      );
    if (!admitted) {
      event.preventDefault();
      return;
    }
    // Before the guest exists, so even its first request goes out prepared.
    prepareSession(session.fromPartition(partition));
  });

  host.on("did-attach-webview", (_event, guest) => {
    guests.add(guest.id);
    guest.once("destroyed", () => {
      guests.delete(guest.id);
      frozen.delete(guest.id);
    });
    // A popup would be a window with nothing around it; the page gets it as a
    // tab instead, and anything that is not a web address goes nowhere.
    guest.setWindowOpenHandler(({ url }) => {
      if (isSafeExternalUrl(url) && !host.isDestroyed())
        host.send(BROWSER_OPEN_TAB, { webContentsId: guest.id, url });
      return { action: "deny" };
    });
    guest.on("dom-ready", () => {
      void guest
        .executeJavaScriptInIsolatedWorld(NAVIGATION_WORLD, [{ code: MOUSE_NAVIGATION }])
        .catch(() => {});
    });
    guest.on("will-navigate", (event, url) => {
      if (!isSafeExternalUrl(url)) event.preventDefault();
    });
    // Fetched in the page's own session, so a logged-in or intranet site shows
    // its icon; only the latest request for a page may answer.
    let latest = 0;
    guest.on("page-favicon-updated", (_icon, favicons) => {
      const url = favicons[0];
      if (!url) return;
      const request = ++latest;
      const send = (dataUrl: string | null) => {
        if (dataUrl && request === latest && !host.isDestroyed() && !guest.isDestroyed())
          host.send(BROWSER_FAVICON, { webContentsId: guest.id, dataUrl });
      };
      if (url.startsWith("data:")) return send(inlineFavicon(url));
      if (!isSafeExternalUrl(url)) return;
      void guest.session
        .fetch(url)
        .then(async (response) =>
          response.ok
            ? faviconDataUrl(
                response.headers.get("content-type"),
                new Uint8Array(await response.arrayBuffer()),
              )
            : null,
        )
        .then(send, () => {});
    });
    guest.on("context-menu", (_menu, params) => {
      Menu.buildFromTemplate(contextMenu(guest, params)).popup({ window });
    });
  });

  const guestOf = (id: number) => {
    const guest = webContents.fromId(id);
    if (!guest || !guests.has(id) || guest.hostWebContents !== host) return null;
    return guest;
  };

  return {
    setLifecycle: async (id: number, state: BrowserLifecycle) => {
      const guest = guestOf(id);
      if (!guest) throw new Error("Not a browser tab of this window.");
      guest.setBackgroundThrottling(state === "background");
      const freeze = state === "frozen";
      if (freeze === frozen.has(id)) return;
      // Freezing keeps the page in memory with all its state but runs none of
      // its code; only the DevTools protocol offers it.
      if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
      await guest.debugger.sendCommand("Page.setWebLifecycleState", {
        state: freeze ? "frozen" : "active",
      });
      if (freeze) frozen.add(id);
      else frozen.delete(id);
    },
  };
}
