import type { IpcRenderer } from "electron";
import {
  BROWSER_ACT,
  BROWSER_BEGIN,
  BROWSER_END,
  BROWSER_CANCEL,
  BROWSER_NAVIGATE,
  BROWSER_SAVE,
  BROWSER_ALLOW_SITE,
  BROWSER_ALLOWED_SITES,
  BROWSER_DRIVE,
  BROWSER_FAVICON,
  BROWSER_LIFECYCLE,
  BROWSER_REVOKE_SITE,
  BROWSER_SITE_ALLOWED,
  BROWSER_SNAPSHOT,
  BROWSER_WAIT_FOR,
  BROWSER_OPEN_EXTERNAL,
  BROWSER_OPEN_TAB,
  type BrowserFavicon,
  type BrowserOpenTab,
  type DesktopBrowser,
} from "@chat/desktop-rpc";
import { profileFromArgv, sharedPartition, temporaryPartition } from "./browser/partitions.ts";

/** Absent when main named no profile, so the page offers no browser at all. */
export const makeBrowserBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  argv: readonly string[],
): DesktopBrowser | null => {
  const profile = profileFromArgv(argv);
  if (profile === null) return null;
  return {
    partition: sharedPartition(profile),
    temporaryPartition: (conversationId) => temporaryPartition(profile, conversationId),
    setLifecycle: (webContentsId, state) => ipc.invoke(BROWSER_LIFECYCLE, { webContentsId, state }),
    onOpenTab: (listener) => {
      const receive = (_event: unknown, payload: BrowserOpenTab) =>
        listener({ webContentsId: payload.webContentsId, url: payload.url });
      ipc.on(BROWSER_OPEN_TAB, receive);
      return () => {
        ipc.removeListener(BROWSER_OPEN_TAB, receive);
      };
    },
    onFavicon: (listener) => {
      const receive = (_event: unknown, payload: BrowserFavicon) =>
        listener({ webContentsId: payload.webContentsId, dataUrl: payload.dataUrl });
      ipc.on(BROWSER_FAVICON, receive);
      return () => {
        ipc.removeListener(BROWSER_FAVICON, receive);
      };
    },
    openExternal: (url) => ipc.invoke(BROWSER_OPEN_EXTERNAL, url),
    agent: {
      begin: (callId, conversationId, deadline) =>
        ipc.invoke(BROWSER_BEGIN, { callId, conversationId, deadline }),
      end: (callId) => ipc.invoke(BROWSER_END, { callId }),
      cancel: (callId) => ipc.invoke(BROWSER_CANCEL, { callId }),
      navigate: (webContentsId, target, callId) =>
        ipc.invoke(BROWSER_NAVIGATE, { webContentsId, target, callId }),
      snapshot: (webContentsId, options, callId) =>
        ipc.invoke(BROWSER_SNAPSHOT, { webContentsId, screenshot: options.screenshot, callId }),
      waitFor: (webContentsId, condition, callId) =>
        ipc.invoke(BROWSER_WAIT_FOR, { webContentsId, ...condition, callId }),
      act: (webContentsId, action, callId) =>
        ipc.invoke(BROWSER_ACT, { webContentsId, action, callId }),
      save: (webContentsId, urls, callId) =>
        ipc.invoke(BROWSER_SAVE, { webContentsId, urls: [...urls], callId }),
      drive: (webContentsId, driving, callId) =>
        ipc.invoke(BROWSER_DRIVE, {
          webContentsId,
          driving: driving && { conversationId: driving.conversationId, allow: [...driving.allow] },
          callId,
        }),
      siteAllowed: (conversationId, url) =>
        ipc.invoke(BROWSER_SITE_ALLOWED, { conversationId, url }),
      allowSite: (conversationId, url, scope) =>
        ipc.invoke(BROWSER_ALLOW_SITE, { conversationId, url, scope }),
      allowedSites: () => ipc.invoke(BROWSER_ALLOWED_SITES),
      revokeSite: (site) => ipc.invoke(BROWSER_REVOKE_SITE, site),
    },
  };
};
