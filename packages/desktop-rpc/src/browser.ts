/**
 * Optional embedded browser, independent of the Work protocol version. The page
 * renders `<webview>` guests itself; this is only what it cannot do alone: name
 * the profile, pace hidden pages and hear about popups.
 */
export const BROWSER_LIFECYCLE = "chat-desktop:browser-lifecycle" as const;
export const BROWSER_OPEN_TAB = "chat-desktop:browser-open-tab" as const;
export const BROWSER_OPEN_EXTERNAL = "chat-desktop:browser-open-external" as const;
export const BROWSER_FAVICON = "chat-desktop:browser-favicon" as const;

/** `active` runs unthrottled, `background` is throttled, `frozen` runs nothing. */
export type BrowserLifecycle = "active" | "background" | "frozen";

/** A page asked for a new window; the shell refused it and offers it as a tab. */
export interface BrowserOpenTab {
  readonly webContentsId: number;
  readonly url: string;
}

/**
 * A page's icon, fetched by the shell in the page's own session and handed over
 * as a `data:` URL: the site's CSP admits no other image origin, and a server
 * proxy would neither reach intranet pages nor stay private.
 */
export interface BrowserFavicon {
  readonly webContentsId: number;
  readonly dataUrl: string;
}

export interface DesktopBrowser {
  /** The persistent profile shared by every chat on this server. */
  readonly partition: string;
  /** An in-memory profile for one temporary chat, gone with the app. */
  temporaryPartition(conversationId: string): string;
  setLifecycle(webContentsId: number, state: BrowserLifecycle): Promise<void>;
  onOpenTab(listener: (event: BrowserOpenTab) => void): () => void;
  onFavicon(listener: (event: BrowserFavicon) => void): () => void;
  openExternal(url: string): Promise<void>;
}

export function readDesktopBrowser(): DesktopBrowser | null {
  const channel = Reflect.get(globalThis, "__chatDesktop");
  if (typeof channel !== "object" || channel === null) return null;
  const browser = Reflect.get(channel, "browser");
  if (typeof browser !== "object" || browser === null) return null;
  if (
    typeof browser.partition !== "string" ||
    typeof browser.temporaryPartition !== "function" ||
    typeof browser.setLifecycle !== "function" ||
    typeof browser.onOpenTab !== "function" ||
    typeof browser.onFavicon !== "function" ||
    typeof browser.openExternal !== "function"
  )
    return null;
  return browser as DesktopBrowser;
}
