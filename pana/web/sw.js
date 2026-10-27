// The service worker: push notifications and their click target (PSH-03, PSH-05). It deliberately
// has no cache for the app's own files: pana's mail must come from panad, never from a stale shell.
import { TAG_PREFIX, clickTarget, leaveClickTarget } from "./links.js";

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
			// The tag is the click's fallback: a browser that drops `data` still names the thread
			// in it, and `clickTarget` reads the same prefix back out.
			tag: payload.tag || (payload.threadId ? `${TAG_PREFIX}${payload.threadId}` : "pana"),
			data: { threadId: payload.threadId, url: payload.url },
			icon: "/icon-192.png",
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(steer(new URL(clickTarget(event.notification), self.location.origin).href));
});

/**
 * Put the app on the thread the notification was about (PSH-03, PSH-05).
 *
 * A browser may deliver the click as a navigation, as a focus with no navigation, or as a fresh
 * window at the app's `start_url` — and a worker cannot navigate a window some browsers will not
 * let it touch. So every path is taken: the target is left in the cache for the page to adopt on
 * its next boot or focus, the window is messaged, and it is navigated where the browser allows it.
 */
async function steer(target) {
	await leaveClickTarget(self.caches, target);
	const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
	const client = windows.find((window) => new URL(window.url).origin === self.location.origin);
	if (!client) {
		await self.clients.openWindow(target);
		return;
	}
	await client.focus().catch(() => {});
	client.postMessage({ type: "open", target });
	try {
		// A same-document hash navigation, so a window already on a thread keeps its scroll and
		// its draft. Chrome refuses a window this worker does not control; the message and the
		// cached target cover that case.
		if (typeof client.navigate === "function") await client.navigate(target);
	} catch {
		// Covered by the message above and by the page's own pickup.
	}
}
