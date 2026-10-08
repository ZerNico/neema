// Shows what this server pushes while neema is closed, and opens where it
// leads. Open pages show their own; a browser with a subscription leaves
// notifications to this worker, so each one appears once.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
