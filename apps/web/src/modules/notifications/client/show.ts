import { readDesktopChrome } from "@chat/desktop-rpc";
import type { AppNotification } from "../schema.ts";

/** Whether this browser, or the desktop app, may show notifications at all. */
export const notificationsSupported = () => typeof Notification !== "undefined";

/**
 * Shows one notification from an open tab or the desktop app, which turns it
 * into a native one. Every tab, and the service worker if a push arrives too,
 * shows it under one tag, so the browser shows it once. A tab never leaves it
 * to the worker: a local subscription says nothing about whether the server
 * still has it. Nothing shows while the person is looking at where it leads.
 */
export function showNotification(
  notification: AppNotification,
  open: (path: string) => void,
): void {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) {
    if (window.location.pathname === notification.path) return;
  }
  const shown = new Notification(notification.title, {
    body: notification.body,
    tag: notification.id,
    icon: "/icon-192.png",
  });
  shown.onclick = () => {
    shown.close();
    window.focus();
    // A hidden desktop window cannot bring itself forward from the page.
    void readDesktopChrome()?.showWindow?.();
    open(notification.path);
  };
}
