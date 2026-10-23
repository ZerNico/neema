import { readDesktopChrome } from "@chat/desktop-rpc";
import { useEffect } from "react";
import { keepInstallOffer } from "./install-prompt.ts";

/**
 * Whether this page runs `public/sw.js`: a secure origin in a browser. The
 * desktop app shows its own page when the server is unreachable and notifies
 * natively.
 */
export const appWorkerSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  readDesktopChrome() === null;

/** Idempotent: the browser keeps one registration per script and scope. */
export const registerAppWorker = () => navigator.serviceWorker.register("/sw.js");

/**
 * Registers the worker on every page, signed in or not, so a load without
 * network shows the offline page and the browser offers to install the app.
 */
export function useAppWorker() {
  useEffect(() => {
    if (!appWorkerSupported()) return;
    // Before the worker: an installable page gets its offer once the worker is up.
    keepInstallOffer();
    registerAppWorker().catch((error: unknown) =>
      console.error("Could not register the service worker", error),
    );
  }, []);
}
