// Answers a page load the network cannot, and shows what this server pushes
// while neema is closed. Open pages show their own notifications; a browser
// with a subscription leaves them to this worker, so each one appears once.

// Bump the suffix when the offline page changes, so installs fetch it again.
const OFFLINE_CACHE = "neema-offline-1";
const OFFLINE_PAGE = "/offline.html";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(OFFLINE_CACHE).then((cache) => cache.add(OFFLINE_PAGE)));
});

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("neema-offline-") && key !== OFFLINE_CACHE) await caches.delete(key);
      // Starts the page request while the worker boots, so it costs no time online.
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  ),
);

// Only page loads, and only when they fail outright. The document is never
// cached: it is no-store and carries a nonce of its own. Everything else
// (assets, server functions, SSE) never passes through here.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate" || event.request.method !== "GET") return;
  event.respondWith(
    (async () => {
      try {
        return (await event.preloadResponse) ?? (await fetch(event.request));
      } catch {
        return (await caches.match(OFFLINE_PAGE)) ?? Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let notification;
  try {
    notification = event.data?.json();
  } catch {
    return;
  }
  if (!notification?.title) return;
  event.waitUntil(
    self.registration.showNotification(notification.title, {
      body: notification.body,
      tag: notification.id,
      icon: "/icon-192.png",
      data: { path: notification.path },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = event.notification.data?.path ?? "/";
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((client) => client.focused) ?? windows[0];
      if (!open) return self.clients.openWindow(path);
      await open.focus();
      // The page routes in place instead of reloading.
      open.postMessage({ type: "open", path });
    })(),
  );
});
