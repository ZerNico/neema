import { useEffect } from "react";
import { appWorkerSupported, registerAppWorker } from "~/ui/app-worker.ts";
import { getPushKey, subscribePush } from "../server/functions.ts";

/** Whether this browser can be reached while closed: the app's worker, and push. */
export const pushSupported = () => appWorkerSupported() && "PushManager" in window;

const keyBytes = (key: string) =>
  Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/**
 * Subscribes this browser, once notifications are allowed, and ties it to
 * this sign-in. Idempotent, so every visit repeats it: a new sign-in in the
 * same browser takes the subscription over, and signing out ends it.
 */
export async function ensurePush() {
  if (!pushSupported() || Notification.permission !== "granted") return;
  const worker = await registerAppWorker();
  await navigator.serviceWorker.ready;
  const subscription =
    (await worker.pushManager.getSubscription()) ??
    (await worker.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(await getPushKey()),
    }));
  const { endpoint, keys } = subscription.toJSON();
  await subscribePush({ data: { endpoint: endpoint!, p256dh: keys!.p256dh!, auth: keys!.auth! } });
}

/** Keeps this browser subscribed while signed in, and routes clicks in place. */
export function usePush(openPath: (path: string) => void) {
  useEffect(() => {
    ensurePush().catch((error: unknown) => console.error("Could not set up push", error));
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
