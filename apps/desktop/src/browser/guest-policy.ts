import { isSafeExternalUrl } from "../config.ts";

/** What `will-attach-webview` reports about the guest a page is creating. */
export interface WebviewParams {
  readonly partition?: unknown;
  readonly src?: unknown;
}

/**
 * Decides one attach and hardens what it lets through. The page is our own
 * server's, but it is still remote code: a guest it creates must browse in one
 * of that server's partitions, start at a web address, and never get a preload
 * or Node, whatever the markup asked for.
 */
export function admitWebview(
  params: WebviewParams,
  preferences: Record<string, unknown>,
  isPartition: (partition: string) => boolean,
): boolean {
  if (typeof params.partition !== "string" || !isPartition(params.partition)) return false;
  const src = typeof params.src === "string" ? params.src : "";
  if (src !== "" && src !== "about:blank" && !isSafeExternalUrl(src)) return false;
  delete preferences.preload;
  delete preferences.preloadURL;
  Object.assign(preferences, {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  });
  return true;
}
