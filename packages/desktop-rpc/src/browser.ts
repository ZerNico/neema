/**
 * Optional embedded browser, independent of the Work protocol version. The page
 * renders `<webview>` guests itself; this is only what it cannot do alone: name
 * the profile, pace hidden pages and hear about popups.
 */
export const BROWSER_LIFECYCLE = "chat-desktop:browser-lifecycle" as const;
export const BROWSER_OPEN_TAB = "chat-desktop:browser-open-tab" as const;
export const BROWSER_OPEN_EXTERNAL = "chat-desktop:browser-open-external" as const;
export const BROWSER_FAVICON = "chat-desktop:browser-favicon" as const;
export const BROWSER_SNAPSHOT = "chat-desktop:browser-snapshot" as const;
export const BROWSER_WAIT_FOR = "chat-desktop:browser-wait-for" as const;
export const BROWSER_DRIVE = "chat-desktop:browser-drive" as const;
export const BROWSER_SITE_ALLOWED = "chat-desktop:browser-site-allowed" as const;
export const BROWSER_ALLOW_SITE = "chat-desktop:browser-allow-site" as const;
export const BROWSER_ALLOWED_SITES = "chat-desktop:browser-allowed-sites" as const;
export const BROWSER_REVOKE_SITE = "chat-desktop:browser-revoke-site" as const;

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

export interface BrowserSnapshot {
  readonly url: string;
  readonly title: string;
  /** The page as an outline, interactive elements carrying references like `[e12]`. */
  readonly text: string;
  readonly truncated: boolean;
  /** JPEG of the visible part, when asked for and the page could be captured. */
  readonly screenshot: { readonly mediaType: "image/jpeg"; readonly base64: string } | null;
}

/**
 * What the model's browser tools need from main: reading a page through the
 * DevTools protocol, waiting on it, gating where a driven page may go, and the
 * sites a person has allowed. Absent from shells that predate it, which is
 * what withholds the tools.
 */
export interface DesktopBrowserAgent {
  snapshot(webContentsId: number, options: { screenshot: boolean }): Promise<BrowserSnapshot>;
  waitFor(
    webContentsId: number,
    condition: { text?: string; urlIncludes?: string; timeoutMs: number },
  ): Promise<{ met: boolean; url: string }>;
  /**
   * Marks a tab as driven for one call, or clears it with null. While driven, a
   * navigation of its page to a site neither allowed for the chat nor the site
   * of an address in `allow` is cancelled; clearing returns the site it stopped.
   */
  drive(
    webContentsId: number,
    driving: { conversationId: string; allow: ReadonlyArray<string> } | null,
  ): Promise<{ blocked: string | null }>;
  siteAllowed(conversationId: string, url: string): Promise<boolean>;
  allowSite(conversationId: string, url: string, scope: "chat" | "always"): Promise<void>;
  /** Sites allowed in every chat on this desktop, for Settings › Devices. */
  allowedSites(): Promise<string[]>;
  revokeSite(site: string): Promise<void>;
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
  readonly agent?: DesktopBrowserAgent;
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
