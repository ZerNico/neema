import {
  clipboard,
  Menu,
  nativeImage,
  session,
  shell,
  webContents,
  type BrowserWindow,
  type DownloadItem,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Session,
  type WebContents,
} from "electron";
import { abortable, browserCalls, type BrowserCallContext } from "./calls.ts";
import { DOWNLOAD_MAX, receiveDownload } from "./download.ts";
import { fetchAllowed, receiveBytes } from "./receive.ts";
import { fetchManual } from "./fetch.ts";
import {
  BROWSER_FAVICON,
  BROWSER_OPEN_TAB,
  LIMITS,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserLifecycle,
  type BrowserSnapshot,
} from "@chat/desktop-rpc";
import { perform, type Cdp } from "./perform.ts";
import { isSafeExternalUrl } from "../config.ts";
import { FAVICON_MAX_BYTES, faviconDataUrl, inlineFavicon } from "./favicon.ts";
import { admitWebview } from "./guest-policy.ts";
import { isBrowserPartition } from "./partitions.ts";
import { blockedSite, type Driving } from "./gate.ts";
import { siteOf } from "./site-grants.ts";
import { saveFiles } from "./save.ts";
import { serializeAxTree, type AxNode } from "./snapshot.ts";

// Guest pages are arbitrary websites. Clipboard writes keep "copy" buttons
// working; everything else (camera, location, notifications, fonts) is refused.
const ALLOWED_PERMISSIONS = new Set(["clipboard-sanitized-write"]);
const preparedSessions = new WeakSet<Session>();

// Electron's input events know only left, middle and right, so nothing maps a
// mouse's back and forward buttons to navigation. An isolated-world listener
// does: it shares the page's DOM but none of its scripts.
const NAVIGATION_WORLD = 1001;
// Where wait conditions are checked and the model's code runs: the page's
// DOM, none of its scripts.
const AGENT_WORLD = 1002;
const SCREENSHOT_MAX_WIDTH = 1280;
const WAIT_MAX_MS = 30_000;
// Results of the last actions by call, so a replayed call never acts twice.
const ACTED_KEEP = 200;
const WAIT_STEP_MS = 250;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DOWNLOAD_LINGER_MS = 10 * 60_000;
const DOWNLOAD_WAIT_MS = 30_000;
const CAPTURE_TRIES = 3;
const CAPTURE_MS = 3_000;
const CAPTURE_RETRY_MS = 300;

// What a promise settles to within `ms`, or null for a failure or no answer.
const within = <T>(promise: Promise<T>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * A page that has not painted yet can fail a capture or never answer one, so
 * each try is bounded and retried. Last, the protocol renders a frame on
 * demand, which may succeed for a page off screen where Electron's did not.
 */
const capture = async (
  guest: WebContents,
  cdp: Cdp,
  call: BrowserCallContext,
  tries = CAPTURE_TRIES,
): Promise<NativeImage | null> => {
  call.check();
  const image = await abortable(within(guest.capturePage(), CAPTURE_MS), call.signal);
  call.check();
  if (image && !image.isEmpty()) return image;
  if (tries > 1) {
    await abortable(pause(CAPTURE_RETRY_MS), call.signal);
    return capture(guest, cdp, call, tries - 1);
  }
  const shot = await within(
    cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }),
    CAPTURE_MS,
  );
  const fallback = shot ? nativeImage.createFromBuffer(Buffer.from(shot.data, "base64")) : null;
  return fallback && !fallback.isEmpty() ? fallback : null;
};

const cdpOf = (guest: WebContents, call?: BrowserCallContext): Cdp => ({
  send: async (method, params) => {
    call?.check();
    if (!guest.debugger.isAttached()) guest.debugger.attach("1.3");
    const pending = guest.debugger.sendCommand(method, params);
    const result = await (call ? abortable(pending, call.signal) : pending);
    call?.check();
    return result;
  },
});
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
  /** Whether a site is allowed for the model in a chat (`site-grants.ts`). */
  siteAllowed: (conversationId: string, url: string) => boolean,
  /** Puts a downloaded file into a chat's workspace; resolves to where it landed. */
  land: (
    conversationId: string,
    fileName: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ) => Promise<string>,
) {
  const host = window.webContents;
  const calls = browserCalls((callId) => cancelOwned(callId));
  const callTabs = new Map<string, number>();
  const downloads = new Map<AbortController, { id: number; callId: string }>();
  const icons = new Map<number, AbortController>();
  const retireGuest = (id: number) => {
    for (const [callId, tab] of callTabs)
      if (tab === id) {
        calls.end(callId);
        callTabs.delete(callId);
      }
    for (const [controller, download] of downloads) if (download.id === id) controller.abort();
    driven.get(id)?.controller.abort();
    icons.get(id)?.abort();
    icons.delete(id);
  };
  const retireHost = () => {
    calls.clear();
    callTabs.clear();
    for (const controller of downloads.keys()) controller.abort();
    for (const controller of icons.values()) controller.abort();
    for (const driving of driven.values()) driving.controller.abort();
    driven.clear();
    lingering.clear();
  };
  window.once("closed", retireHost);
  host.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) retireHost();
  });
  const guests = new Set<number>();
  // Downloads a page started while the model drove it, per tab, and the
  // workspace paths of those finished but not yet reported to a call.
  const downloading = new Map<number, Set<Promise<void>>>();
  const saved = new Map<number, string[]>();
  // The model's page keeps downloading for it after a call: a click starts one a
  // moment later, a script after it returned. Until the person uses the tab.
  const lingering = new Map<number, { conversationId: string; callId: string; until: number }>();
  const downloadSessions = new WeakSet<Session>();
  const frozen = new Set<number>();
  // Tabs the model is acting through right now, and the first address it was stopped at.
  const driven = new Map<
    number,
    Driving & { blocked: string | null; callId: string; controller: AbortController }
  >();
  const cancelOwned = (callId: string) => {
    callTabs.delete(callId);
    for (const [controller, download] of downloads)
      if (download.callId === callId) controller.abort();
    for (const [id, recent] of lingering) if (recent.callId === callId) lingering.delete(id);
    for (const driving of driven.values())
      if (driving.callId === callId) driving.controller.abort();
  };
  // Per tab, how many page pixels one pixel of its last screenshot covers.
  const screenshotScale = new Map<number, number>();
  const acted = new Map<string, Promise<BrowserActionResult>>();
  // Per tab, the references of its last outline, for the actions to come.
  const references = new Map<number, Map<string, number>>();
  // Per tab, nodes a secret was typed into, masked in every later outline.
  const secrets = new Map<number, Set<number>>();

  // While the model drives a tab its page may not wander to a site nobody
  // allowed, however it gets there: a link, a script, a redirect. The person's
  // own browsing is never gated.
  const gate = (id: number, event: { preventDefault(): void }, url: string) => {
    const driving = driven.get(id);
    if (!driving || !blockedSite(driving, url, siteAllowed)) return;
    event.preventDefault();
    // The whole address, so the page can go on there once the person allows it.
    driving.blocked ??= url;
  };

  // Only what the model's page downloads goes to the chat's workspace, and never
  // through a dialog over the app; the person's own downloads ask where to save.
  const onDownload = (_event: Electron.Event, item: DownloadItem, source: WebContents) => {
    const id = source.id;
    if (!guests.has(id)) return;
    const recent = lingering.get(id);
    const driving = driven.get(id);
    const owning = driving ?? (recent && recent.until > Date.now() ? recent : null);
    if (!owning) return;
    // A retained drive still gates navigation, but revoked work cannot publish.
    if (driving) {
      try {
        driving.controller.signal.throwIfAborted();
        calls.get(driving.callId);
      } catch {
        item.cancel();
        return;
      }
    }
    if (downloads.size >= DOWNLOAD_MAX) {
      item.cancel();
      return;
    }
    const controller = new AbortController();
    downloads.set(controller, { id, callId: owning.callId });
    const finished = receiveDownload(
      item,
      async (name, bytes, signal) => {
        signal.throwIfAborted();
        const path = await land(owning.conversationId, name, bytes, signal);
        if (!signal.aborted && guests.has(id)) saved.set(id, [...(saved.get(id) ?? []), path]);
      },
      controller.signal,
    )
      .catch(() => {})
      .finally(() => {
        downloads.delete(controller);
        downloading.get(id)?.delete(finished);
      });
    const pending = downloading.get(id) ?? new Set<Promise<void>>();
    downloading.set(id, pending.add(finished));
  };

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
    const profileSession = session.fromPartition(partition);
    prepareSession(profileSession);
    if (!downloadSessions.has(profileSession)) {
      downloadSessions.add(profileSession);
      profileSession.on("will-download", onDownload);
      window.once("closed", () => profileSession.removeListener("will-download", onDownload));
    }
  });

  host.on("did-attach-webview", (_event, guest) => {
    guests.add(guest.id);
    const id = guest.id;
    guest.once("destroyed", () => {
      retireGuest(id);
      guests.delete(id);
      downloading.delete(id);
      frozen.delete(id);
      lingering.delete(id);
      saved.delete(id);
      driven.delete(id);
      references.delete(id);
      screenshotScale.delete(id);
      secrets.delete(id);
    });
    // The person using the tab takes it back: their downloads ask where to save.
    guest.on("input-event", (_input, input) => {
      if (!driven.has(id) && (input.type === "mouseDown" || input.type === "keyDown"))
        lingering.delete(id);
    });
    // A new document has new nodes: old references and coordinates mean nothing there.
    guest.on("did-navigate", () => {
      references.delete(id);
      screenshotScale.delete(id);
      secrets.delete(id);
    });
    // A popup would be a window with nothing around it; the page gets it as a
    // tab instead, and anything that is not a web address goes nowhere.
    guest.setWindowOpenHandler(({ url }) => {
      const driving = driven.get(id);
      if (driving && blockedSite(driving, url, siteAllowed)) {
        driving.blocked ??= url;
        return { action: "deny" };
      }
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
      else gate(id, event, url);
    });
    guest.on("will-redirect", (event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) gate(id, event, url);
    });
    // A page's own history.back() raises no will-navigate, so it is stopped once started.
    guest.on("did-start-navigation", (_started, url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace && isSafeExternalUrl(url))
        gate(id, { preventDefault: () => guest.stop() }, url);
    });
    // Fetched in the page's own session, so a logged-in or intranet site shows
    // its icon; only the latest request for a page may answer.
    let latest = 0;
    guest.on("page-favicon-updated", (_icon, favicons) => {
      icons.get(id)?.abort();
      icons.delete(id);
      const request = ++latest;
      const url = favicons[0];
      if (!url) return;
      // Redirects keep their original authority even after the drive ends.
      const driving = driven.get(id);
      let call: BrowserCallContext | undefined;
      if (driving) {
        try {
          driving.controller.signal.throwIfAborted();
          call = calls.get(driving.callId);
        } catch {
          return;
        }
      }
      const send = (dataUrl: string | null) => {
        if (
          dataUrl &&
          request === latest &&
          !host.isDestroyed() &&
          !guest.isDestroyed() &&
          !call?.signal.aborted &&
          !driving?.controller.signal.aborted
        )
          host.send(BROWSER_FAVICON, { webContentsId: guest.id, dataUrl });
      };
      if (url.startsWith("data:")) return send(inlineFavicon(url));
      if (!isSafeExternalUrl(url)) return;
      const controller = new AbortController();
      icons.set(id, controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(5_000),
        ...(call && driving ? [call.signal, driving.controller.signal] : []),
      ]);
      void fetchAllowed(
        url,
        (address, receiving) => fetchManual(guest.session, address, receiving, FAVICON_MAX_BYTES),
        (address) => {
          call?.check();
          return !driving || !blockedSite(driving, address, siteAllowed);
        },
        signal,
      )
        .then(async (response) => {
          if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            return null;
          }
          return faviconDataUrl(
            response.headers.get("content-type"),
            await receiveBytes(response, FAVICON_MAX_BYTES, signal),
          );
        })
        .then(send, () => {})
        .finally(() => {
          if (icons.get(id) === controller) icons.delete(id);
        });
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

  const requireGuest = (id: number) => {
    const guest = guestOf(id);
    if (!guest) throw new Error("Not a browser tab of this window.");
    return guest;
  };

  const requireCall = (id: number, callId: string) => {
    requireGuest(id);
    const call = calls.get(callId);
    const bound = callTabs.get(callId);
    if (bound !== undefined && bound !== id) throw new Error("The browser call changed tabs.");
    callTabs.set(callId, id);
    return call;
  };
  const requireDrive = (id: number, callId: string) => {
    const call = requireCall(id, callId);
    const driving = driven.get(id);
    if (!driving || driving.callId !== callId) throw new Error("This call is not driving the tab.");
    driving.controller.signal.throwIfAborted();
    return call;
  };

  return {
    begin: calls.begin,
    end: (callId: string) => {
      calls.end(callId);
      callTabs.delete(callId);
    },
    cancel: (callId: string) => {
      calls.end(callId);
      callTabs.delete(callId);
      cancelOwned(callId);
    },
    navigate: async (
      id: number,
      target: { url: string } | { action: "back" | "forward" | "reload" },
      callId: string,
    ) => {
      const call = requireDrive(id, callId);
      const guest = requireGuest(id);
      call.check();
      if ("url" in target) {
        if (!isSafeExternalUrl(target.url)) throw new Error("Not a web address.");
        if (blockedSite(driven.get(id)!, target.url, siteAllowed)) {
          driven.get(id)!.blocked ??= target.url;
          return;
        }
        await abortable(
          guest.loadURL(target.url).catch(() => {}),
          call.signal,
        );
        call.check();
      } else if (target.action === "reload") guest.reload();
      else {
        // History goes where it went before, which may be a site this drive never allowed.
        const history = guest.navigationHistory;
        const step = target.action === "back" ? -1 : 1;
        const entry = history.getEntryAtIndex(history.getActiveIndex() + step);
        if (entry && blockedSite(driven.get(id)!, entry.url, siteAllowed)) {
          driven.get(id)!.blocked ??= entry.url;
          return;
        }
        if (step < 0) history.goBack();
        else history.goForward();
      }
    },
    snapshot: async (
      id: number,
      options: { screenshot: boolean },
      callId: string,
    ): Promise<BrowserSnapshot> => {
      const call = requireCall(id, callId);
      const guest = requireGuest(id);
      const cdp = cdpOf(guest, call);
      const { nodes } = await cdp.send<{ nodes: AxNode[] }>("Accessibility.getFullAXTree");
      const outline = serializeAxTree(nodes, { secrets: secrets.get(id) ?? new Set() });
      references.set(id, outline.refs);
      let screenshot: BrowserSnapshot["screenshot"] = null;
      if (options.screenshot) {
        // When no try yields a picture, the caller says so rather than
        // sending an empty one.
        const image = await capture(guest, cdp, call);
        call.check();
        if (image && !image.isEmpty()) {
          const fitted =
            image.getSize().width > SCREENSHOT_MAX_WIDTH
              ? image.resize({ width: SCREENSHOT_MAX_WIDTH })
              : image;
          screenshot = { mediaType: "image/jpeg", base64: fitted.toJPEG(70).toString("base64") };
          const metrics = await cdp
            .send<{ cssVisualViewport?: { clientWidth: number } }>("Page.getLayoutMetrics")
            .catch(() => null);
          const cssWidth = metrics?.cssVisualViewport?.clientWidth;
          if (cssWidth) screenshotScale.set(id, cssWidth / fitted.getSize().width);
        }
      }
      return {
        url: guest.getURL(),
        title: guest.getTitle(),
        text: outline.text,
        truncated: outline.truncated,
        screenshot,
      };
    },
    waitFor: async (
      id: number,
      condition: { text?: string; urlIncludes?: string; timeoutMs: number },
      callId: string,
    ) => {
      const call = requireCall(id, callId);
      const guest = requireGuest(id);
      // Fixed code with the text as a JSON literal: nothing the page or the
      // model wrote ever runs.
      const probe = condition.text
        ? `document.body ? document.body.innerText.includes(${JSON.stringify(condition.text)}) : false`
        : "true";
      const deadline = Math.min(
        call.deadline,
        Date.now() + Math.min(Math.max(condition.timeoutMs, 0), WAIT_MAX_MS),
      );
      for (;;) {
        call.check();
        if (guest.isDestroyed()) return { met: false, url: "" };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { met: false, url: guest.getURL() };
        const urlMet = !condition.urlIncludes || guest.getURL().includes(condition.urlIncludes);
        const textMet =
          urlMet &&
          (!condition.text ||
            // oxlint-disable-next-line eslint/no-await-in-loop -- each probe bounded by the remaining wait budget
            (await abortable(
              within(
                guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: probe }]),
                remaining,
              ),
              call.signal,
            )) === true);
        call.check();
        if (urlMet && textMet) return { met: true, url: guest.getURL() };
        if (Date.now() >= deadline) return { met: false, url: guest.getURL() };
        // oxlint-disable-next-line eslint/no-await-in-loop -- bounded pause between probes
        await abortable(pause(Math.min(WAIT_STEP_MS, deadline - Date.now())), call.signal);
      }
    },
    act: (id: number, action: BrowserAction, callId: string): Promise<BrowserActionResult> => {
      const owning = requireDrive(id, callId);
      const driving = driven.get(id)!;
      const call = {
        ...owning,
        signal: AbortSignal.any([owning.signal, driving.controller.signal]),
        check: () => {
          requireDrive(id, callId);
          if (driven.get(id) !== driving) throw new Error("The drive ended.");
        },
      };
      const guest = requireGuest(id);
      const key = `${id}:${action.callId}`;
      const earlier = acted.get(key);
      if (earlier) return earlier;
      const result = perform(
        {
          cdp: cdpOf(guest, call),
          evaluate: async (code) => {
            requireDrive(id, callId);
            const value = await abortable(
              guest.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code }], true),
              call.signal,
            );
            call.check();
            return value;
          },
          node: (ref) => references.get(id)?.get(ref) ?? null,
          screenshotScale: screenshotScale.get(id),
          typedSecret: (node) => {
            const typed = secrets.get(id) ?? new Set<number>();
            secrets.set(id, typed.add(node));
          },
        },
        action,
      );
      acted.set(key, result);
      // Only an action that ran is remembered: one that failed to reach the
      // page did nothing, so a replay may try it again.
      result.catch(() => acted.delete(key));
      if (acted.size > ACTED_KEEP) acted.delete(acted.keys().next().value!);
      return result;
    },
    // Only while a call drives the tab, and only where its gate would let the page go.
    save: async (id: number, urls: ReadonlyArray<string>, callId: string) => {
      const call = requireDrive(id, callId);
      const guest = requireGuest(id);
      const driving = driven.get(id)!;
      const signal = AbortSignal.any([call.signal, driving.controller.signal]);
      return saveFiles(
        urls,
        (url, receiving) => {
          requireDrive(id, callId);
          return fetchManual(guest.session, url, receiving, LIMITS.importBytes);
        },
        (fileName, bytes, receiving) => {
          requireDrive(id, callId);
          receiving.throwIfAborted();
          return land(driving.conversationId, fileName, bytes, receiving);
        },
        { signal, allowed: (url) => !blockedSite(driving, url, siteAllowed) },
      );
    },
    drive: async (
      id: number,
      driving: { conversationId: string; allow: ReadonlyArray<string> } | null,
      callId: string,
    ) => {
      requireGuest(id);
      const previous = driven.get(id);
      if (driving) {
        const call = requireCall(id, callId);
        if (call.conversationId !== driving.conversationId)
          throw new Error("The browser call changed chats.");
        if (previous) throw new Error("A call is already driving this tab.");
        driven.set(id, {
          conversationId: driving.conversationId,
          callId,
          controller: new AbortController(),
          allow: new Set(driving.allow.map(siteOf).filter((site) => site !== null)),
          blocked: null,
        });
        return { blocked: null, saved: [] };
      }
      if (!previous) return { blocked: null, saved: [] };
      if (previous.callId !== callId) throw new Error("That drive belongs to another call.");
      previous.controller.abort(new Error("The drive ended."));
      driven.delete(id);
      try {
        calls.get(callId);
        lingering.set(id, {
          conversationId: previous.conversationId,
          callId,
          until: Date.now() + DOWNLOAD_LINGER_MS,
        });
      } catch {
        lingering.delete(id);
      }
      // Downloads under way finish into the workspace before the call reports.
      await within(Promise.all(downloading.get(id) ?? []), DOWNLOAD_WAIT_MS);
      const landed = saved.get(id) ?? [];
      saved.delete(id);
      return { blocked: previous?.blocked ?? null, saved: landed };
    },
    setLifecycle: async (id: number, state: BrowserLifecycle) => {
      const guest = requireGuest(id);
      guest.setBackgroundThrottling(state === "background");
      const freeze = state === "frozen";
      if (freeze === frozen.has(id)) return;
      // Freezing keeps the page in memory with all its state but runs none of
      // its code; only the DevTools protocol offers it.
      await cdpOf(guest).send("Page.setWebLifecycleState", {
        state: freeze ? "frozen" : "active",
      });
      if (freeze) frozen.add(id);
      else frozen.delete(id);
    },
  };
}
