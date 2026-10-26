// The service worker: push notifications and their click target (PSH-03). It deliberately has
// no cache: pana's mail must come from panad, never from a stale shell.
import { notificationTarget } from "./links.js";

self.addEventListener("fetch", () => {
	// A no-op fetch listener keeps the app installable while leaving every request to the network.
});

self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data ? event.data.json() : {};
	} catch {
		payload = { title: "pana", body: event.data ? event.data.text() : "" };
	}
	event.waitUntil(
		self.registration.showNotification(payload.title || "pana", {
			body: payload.body || "",
			tag: payload.tag || "pana",
			data: { threadId: payload.threadId, url: payload.url },
			icon: "/favicon.svg",
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const target = notificationTarget(event.notification.data || {});
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			const client = windows.find((window) => new URL(window.url).origin === location.origin);
			if (client) {
				await client.focus();
				client.postMessage({ type: "open", target });
			} else {
				await self.clients.openWindow(target);
			}
		})(),
	);
});
