import type { BrowserWindowConstructorOptions } from "electron";
import type { DesktopPlatform, DesktopTheme } from "@chat/desktop-rpc";

export const CHROME_STATE = "chat-desktop:chrome-state";
export const CHROME_GET_STATE = "chat-desktop:chrome-get-state";
export const CHROME_SET_THEME = "chat-desktop:chrome-set-theme";
export const RECOVERY_RETRY = "chat-desktop:recovery-retry";
export const TITLEBAR_HEIGHT = 48;

export const desktopPlatform = (platform: string): DesktopPlatform =>
  platform === "darwin" || platform === "win32" ? platform : "linux";

const palette = (dark: boolean) => ({
  color: dark ? "#0a0a0a" : "#ffffff",
  symbolColor: dark ? "#fafafa" : "#0a0a0a",
  height: TITLEBAR_HEIGHT,
});

export const chromeOptions = (platform: DesktopPlatform, dark: boolean) =>
  ({
    backgroundColor: palette(dark).color,
    autoHideMenuBar: platform !== "darwin",
    ...(platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          titleBarOverlay: true,
          trafficLightPosition: { x: 16, y: 17 },
        }
      : { titleBarStyle: "hidden", titleBarOverlay: palette(dark) }),
  }) satisfies BrowserWindowConstructorOptions;

interface PageContents {
  readonly mainFrame: { readonly url: string };
}

/** Window identity and frame identity matter even for presentation-only calls. */
export const isPageSender = (
  event: { readonly sender: PageContents; readonly senderFrame: { readonly url: string } | null },
  contents: PageContents | undefined,
  acceptsUrl: (url: string) => boolean,
) =>
  contents !== undefined &&
  event.sender === contents &&
  event.senderFrame === contents.mainFrame &&
  acceptsUrl(event.senderFrame?.url ?? "");

interface ChromeWindow {
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  setBackgroundColor(color: string): void;
  setTitleBarOverlay(options: ReturnType<typeof palette>): void;
  on(event: string, listener: () => void): unknown;
  once(event: string, listener: () => void): unknown;
  webContents: {
    on(event: string, listener: () => void): unknown;
    send(channel: string, state: { fullscreen: boolean }): void;
  };
}

interface ThemeSource {
  themeSource: DesktopTheme;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
}

export const attachChrome = (
  window: ChromeWindow,
  nativeTheme: ThemeSource,
  platform: DesktopPlatform,
) => {
  let htmlFullscreen = false;
  const getState = () => ({ fullscreen: window.isFullScreen() || htmlFullscreen });
  const publish = () => {
    if (!window.isDestroyed()) window.webContents.send(CHROME_STATE, getState());
  };
  const applyTheme = () => {
    if (window.isDestroyed()) return;
    const colors = palette(nativeTheme.shouldUseDarkColors);
    window.setBackgroundColor(colors.color);
    if (platform !== "darwin") window.setTitleBarOverlay(colors);
  };
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  window.on("enter-html-full-screen", () => {
    htmlFullscreen = true;
    publish();
  });
  window.on("leave-html-full-screen", () => {
    htmlFullscreen = false;
    publish();
  });
  window.webContents.on("did-navigate", () => {
    htmlFullscreen = false;
    publish();
  });
  nativeTheme.on("updated", applyTheme);
  window.once("closed", () => nativeTheme.removeListener("updated", applyTheme));
  applyTheme();
  return {
    getState,
    setTheme: (theme: unknown) => {
      if (theme !== "light" && theme !== "dark" && theme !== "system")
        throw new Error("Invalid desktop theme.");
      nativeTheme.themeSource = theme;
      applyTheme();
    },
  };
};
