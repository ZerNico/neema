import { readDesktopChrome } from "@chat/desktop-rpc";
import { useEffect } from "react";
import { describeSession } from "~/modules/settings/ui/describe-session.ts";
import { getPushKey, subscribePush, unsubscribePush } from "../server/functions.ts";

/**
 * Whether this browser can be reached while closed. Needs a secure origin and
 * a service worker; the desktop app notifies natively instead.
 */
export const pushSupported = () =>
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator &&
  "PushManager" in window &&
  readDesktopChrome() === null;

const registration = () =>
  pushSupported() ? navigator.serviceWorker.getRegistration() : Promise.resolve(undefined);

/** This browser's push subscription, if it has one. */
export const currentPushSubscription = async () =>
  (await (await registration())?.pushManager.getSubscription()) ?? null;

/** Subscribes this browser and tells the server; asks for permission first. */
export async function enablePush() {
  if ((await Notification.requestPermission()) !== "granted") return false;
  const worker = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const key = await getPushKey();
  const subscription = await worker.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    ),
  });
  const { endpoint, keys } = subscription.toJSON();
  await subscribePush({
    data: {
      endpoint: endpoint!,
      p256dh: keys!.p256dh!,
      auth: keys!.auth!,
      label: describeSession(navigator.userAgent),
    },
  });
  return true;
}

/**
 * Stops pushes to this browser. Signing out calls it too, so a shared
 * computer stops receiving the last person's notifications.
 */
export async function disablePush() {
  const subscription = await currentPushSubscription();
  if (!subscription) return;
  await unsubscribePush({ data: { endpoint: subscription.endpoint } }).catch((error: unknown) =>
    console.error("Could not forget this browser's push subscription", error),
  );
  await subscription.unsubscribe();
}

/** Routes a click on a pushed notification inside the open page. */
export function usePushNavigation(openPath: (path: string) => void) {
  useEffect(() => {
    if (!pushSupported()) return;
    const receive = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type === "open" && typeof data.path === "string" && data.path.startsWith("/"))
        openPath(data.path);
    };
    navigator.serviceWorker.addEventListener("message", receive);
    return () => navigator.serviceWorker.removeEventListener("message", receive);
  }, [openPath]);
}
