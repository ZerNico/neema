import type { IpcRenderer } from "electron";
import {
  BROWSER_FAVICON,
  BROWSER_LIFECYCLE,
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
  };
};
