"use strict";
// No fetch handler: mail must always come from the bridge, never a stale cache.
// The worker exists for showNotification and for focusing the app on click.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { key, subject } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      const client = windows.find((w) => new URL(w.url).origin === location.origin);
      if (client) {
        await client.focus();
        if (key) client.postMessage({ type: "open", key, subject });
      } else {
        await self.clients.openWindow("/" + (key ? "?open=" + encodeURIComponent(key) : ""));
      }
    })(),
  );
});
