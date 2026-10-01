/**
 * The app-wide default agent, which browser tabs send: Electron's own, as it
 * would be without our app's name in it. Measured against real Cloudflare
 * Turnstile sitekeys inside a `<webview>`, only what Electron generates passes,
 * and only while the app-wide default is left that way too. A Chrome-looking
 * string without `Electron/`, a token Electron did not write, or an app-wide
 * default carrying our server token all failed, even with the guest's own
 * profile set back to the native string.
 */
export const browserUserAgent = (nativeUserAgent: string, appName: string) =>
  nativeUserAgent.replace(new RegExp(` ${appName.replace(/[^\w-]/g, "\\$&")}/\\S+`), "");
