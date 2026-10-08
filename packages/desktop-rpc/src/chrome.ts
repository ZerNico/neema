export type DesktopTheme = "light" | "dark" | "system";
export type DesktopPlatform = "darwin" | "win32" | "linux";
export interface DesktopChromeState {
  readonly fullscreen: boolean;
}

/** Optional presentation capability, independent of the Work protocol version. */
export interface DesktopChrome {
  readonly platform: DesktopPlatform;
  getState(): Promise<DesktopChromeState>;
  onState(listener: (state: DesktopChromeState) => void): () => void;
  setTheme(theme: DesktopTheme): Promise<void>;
  /**
   * Brings the window forward, hidden or minimized, for a notification the
   * person clicked. Absent on shells built before it.
   */
  showWindow?(): Promise<void>;
}

export function readDesktopChrome(): DesktopChrome | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const chrome = Reflect.get(channel, "chrome");
  if (typeof chrome !== "object" || chrome === null) return null;
  if (
    !["darwin", "win32", "linux"].includes(chrome.platform) ||
    typeof chrome.getState !== "function" ||
    typeof chrome.onState !== "function" ||
    typeof chrome.setTheme !== "function"
  )
    return null;
  return chrome as DesktopChrome;
}
