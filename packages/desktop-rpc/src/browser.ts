/**
 * Optional embedded browser, independent of the bridge's protocol version. The page
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
export const BROWSER_ACT = "chat-desktop:browser-act" as const;
export const BROWSER_SAVE = "chat-desktop:browser-save" as const;
export const BROWSER_BEGIN = "chat-desktop:browser-begin" as const;
export const BROWSER_END = "chat-desktop:browser-end" as const;
export const BROWSER_CANCEL = "chat-desktop:browser-cancel" as const;
export const BROWSER_NAVIGATE = "chat-desktop:browser-navigate" as const;
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
 * One thing done to a page as the person. `callId` makes a replayed call
 * return the first result instead of acting twice; `secret` allows typing into
 * a password field, which anything else is refused.
 */
export type BrowserAction =
  | {
      readonly kind: "click";
      readonly callId: string;
      readonly ref?: string;
      readonly x?: number;
      readonly y?: number;
    }
  | {
      readonly kind: "type";
      readonly callId: string;
      readonly ref: string;
      readonly text: string;
      readonly clear: boolean;
      readonly submit: boolean;
      readonly secret: boolean;
    }
  | { readonly kind: "press"; readonly callId: string; readonly key: string }
  | {
      readonly kind: "scroll";
      readonly callId: string;
      /** Pixels; positive scrolls down and right. */
      readonly deltaX: number;
      readonly deltaY: number;
      /** A scrollable element to scroll instead of the page. */
      readonly ref?: string;
    }
  | {
      readonly kind: "select";
      readonly callId: string;
      readonly ref: string;
      readonly value: string;
    }
  | { readonly kind: "evaluate"; readonly callId: string; readonly expression: string };

export type BrowserActionResult =
  | { readonly ok: true; readonly value?: string; readonly truncated?: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | "stale-ref"
        | "no-screenshot"
        | "password-field"
        | "not-select"
        | "no-option"
        | "bad-key"
        | "not-editable"
        | "script-error";
      readonly message: string;
    };

/**
 * What the model's browser tools need from main: reading a page through the
 * DevTools protocol, waiting on it, gating where a driven page may go, and the
 * sites a person has allowed. Absent from shells that predate it, which is
 * what withholds the tools.
 */
export interface DesktopBrowserAgent {
  begin(callId: string, conversationId: string, deadline: number): Promise<void>;
  end(callId: string): Promise<void>;
  cancel(callId: string): Promise<void>;
  navigate(
    webContentsId: number,
    target: { url: string } | { action: "back" | "forward" | "reload" },
    callId: string,
  ): Promise<void>;
  snapshot(
    webContentsId: number,
    options: { screenshot: boolean },
    callId: string,
  ): Promise<BrowserSnapshot>;
  waitFor(
    webContentsId: number,
    condition: { text?: string; urlIncludes?: string; timeoutMs: number },
    callId: string,
  ): Promise<{ met: boolean; url: string }>;
  /**
   * Marks a tab as driven for one call, or clears it with null. While driven, a
   * navigation of its page to a site neither allowed for the chat nor the site
   * of an address in `allow` is cancelled; clearing returns the first address it stopped,
   * and where in the chat's workspace the files its page downloaded meanwhile were saved.
   */
  drive(
    webContentsId: number,
    driving: { conversationId: string; allow: ReadonlyArray<string> } | null,
    callId: string,
  ): Promise<{ blocked: string | null; saved: ReadonlyArray<string> }>;
  /** Execution identity is separate from action.callId, which remains its stable replay key. */
  act(webContentsId: number, action: BrowserAction, callId: string): Promise<BrowserActionResult>;
  /**
   * Fetches files with the tab's own session into the driving chat's workspace,
   * each where it landed or why not. Only addresses the tab's gate lets through.
   */
  save(
    webContentsId: number,
    urls: ReadonlyArray<string>,
    callId: string,
  ): Promise<
    ReadonlyArray<{
      url: string;
      path?: string;
      error?: string;
      /** Its site is not allowed for the chat; the caller may ask the user and try again. */
      blocked?: true;
      /** A redirect destination refused before contact. */
      blockedUrl?: string;
    }>
  >;
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
  const admitted = browser as DesktopBrowser;
  if (
    admitted.agent &&
    (typeof admitted.agent.begin !== "function" ||
      typeof admitted.agent.end !== "function" ||
      typeof admitted.agent.cancel !== "function" ||
      typeof admitted.agent.navigate !== "function")
  ) {
    const { agent: _agent, ...humanBrowser } = admitted;
    return humanBrowser;
  }
  return admitted;
}
