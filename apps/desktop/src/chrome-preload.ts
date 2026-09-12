import type { IpcRenderer } from "electron";
import type { DesktopChrome, DesktopChromeState } from "@chat/desktop-rpc";
import { CHROME_GET_STATE, CHROME_SET_THEME, CHROME_STATE, desktopPlatform } from "./chrome.ts";

export const makeChromeBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  platform: string,
): DesktopChrome => ({
  platform: desktopPlatform(platform),
  getState: () => ipc.invoke(CHROME_GET_STATE),
  onState: (listener) => {
    const receive = (_event: unknown, state: DesktopChromeState) =>
      listener({ fullscreen: state.fullscreen });
    ipc.on(CHROME_STATE, receive);
    return () => {
      ipc.removeListener(CHROME_STATE, receive);
    };
  },
  setTheme: (theme) => ipc.invoke(CHROME_SET_THEME, theme),
});

/** Local pages can observe presentation, but cannot change the server's theme. */
export const makeLocalChromeBridge = (
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  platform: string,
) => {
  const { setTheme: _setTheme, ...chrome } = makeChromeBridge(ipc, platform);
  return chrome;
};
