// Web Push on the browser's side: the subscription the app makes (PSH-02), and the click that
// lands on its thread (PSH-03, PSH-05). Browser hooks are parameters, so Node runs every outcome;
// the service worker runs with `self` stubbed, called the way a browser would call it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { PENDING_KEY, clickTarget, leaveClickTarget, notificationTarget, notifyTag, takeClickTarget } from "../web/links.js";
import { subscribeToPush, urlBase64ToUint8Array, type PushSubscriptionLike } from "../web/push.js";

function recordingRegistration(subscription: PushSubscriptionLike | null) {
	const calls: Array<{ userVisibleOnly: boolean; key: Uint8Array }> = [];
	const registration = {
		pushManager: {
			async getSubscription() {
				return subscription;
			},
			async subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) {
				calls.push({ userVisibleOnly: options.userVisibleOnly, key: options.applicationServerKey });
				return {
					endpoint: "https://push.example/new",
					toJSON() {
						return { endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } };
					},
				};
			},
		},
	};
	return { registration, calls };
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("PSH-02 the app subscribes after the user allows notifications", () => {
	it("PSH-02 asks for permission and posts the new subscription with the server key", async () => {
		const key = "BEv1EDtILf1kHQLWIE-suliwhvMNYqSRQ7lD0QCR56IkomfN6aOVZQz_FezcstfV4sFIBx1QxtSXSWliz9jzCWs";
		const { registration, calls } = recordingRegistration(null);
		const posted: unknown[] = [];
		let prompted = 0;

		const result = await subscribeToPush({
			permission: "default",
			requestPermission: async () => {
				prompted++;
				return "granted";
			},
			register: async () => registration,
			getKey: async () => key,
			post: async (subscription) => {
				posted.push(subscription);
			},
		});

		expect(prompted).toBe(1);
		expect(result).toEqual({ subscribed: true, endpoint: "https://push.example/new" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.userVisibleOnly).toBe(true);
		expect(calls[0]!.key).toEqual(urlBase64ToUint8Array(key));
		expect(posted).toEqual([{ endpoint: "https://push.example/new", keys: { p256dh: "p", auth: "a" } }]);
	});

	it("PSH-02 does nothing when the user denies or the browser has no push", async () => {
		let registered = 0;
		const denied = await subscribeToPush({
			permission: "default",
			requestPermission: async () => "denied",
			register: async () => {
				registered++;
				return undefined;
			},
			getKey: async () => "x",
			post: async () => {},
		});
		expect(denied).toMatchObject({ subscribed: false, reason: "permission denied" });
		expect(registered).toBe(0);

		const unavailable = await subscribeToPush({
			permission: "granted",
			register: async () => undefined,
			getKey: async () => "x",
			post: async () => {},
		});
		expect(unavailable).toMatchObject({ subscribed: false, reason: "push is not available" });
	});

	it("PSH-02 reuses an existing subscription instead of asking for another", async () => {
		const existing = {
			endpoint: "https://push.example/old",
			toJSON() {
				return { endpoint: "https://push.example/old", keys: { p256dh: "p", auth: "a" } };
			},
		};
		const { registration, calls } = recordingRegistration(existing);
		const posted: unknown[] = [];
		const result = await subscribeToPush({
			permission: "granted",
			register: async () => registration,
			getKey: async () => "unused",
			post: async (subscription) => {
				posted.push(subscription);
			},
		});
		expect(result.endpoint).toBe("https://push.example/old");
		expect(calls).toHaveLength(0);
		expect(posted).toHaveLength(1);
	});

	it("PSH-02 decodes a URL-safe VAPID key", () => {
		expect([...urlBase64ToUint8Array("AQID")]).toEqual([1, 2, 3]);
		expect(urlBase64ToUint8Array("BEv1EDtILf1kHQLWIE-suliwhvMNYqSRQ7lD0QCR56IkomfN6aOVZQz_FezcstfV4sFIBx1QxtSXSWliz9jzCWs")).toHaveLength(65);
	});
});

/** A Cache Storage over a Map: `put` and `match` carry `Response` bodies, so they must be cloned. */
function fakeStorage() {
	const entries = new Map<string, Response>();
	return {
		entries,
		async open() {
			return {
				async put(key: string, response: Response) {
					entries.set(key, response.clone());
				},
				async match(key: string) {
					return entries.get(key)?.clone();
				},
				async delete(key: string) {
					return entries.delete(key);
				},
			};
		},
	};
}

// ---- The click a notification delivers (PSH-03, PSH-05) ------------------------------------

describe("PSH-03 a click knows which thread it was about", () => {
	it("PSH-03 reads the thread from the payload, and from the tag when a browser drops it", () => {
		expect(clickTarget({ data: { threadId: "T1" }, tag: "pana:thread:T1" })).toBe("/#/threads/T1");
		// Safari has dropped notification `data` before; the tag is the field it keeps.
		expect(clickTarget({ data: undefined, tag: "pana:thread:T1" })).toBe("/#/threads/T1");
		expect(clickTarget({ data: {}, tag: "pana:thread:T1" })).toBe("/#/threads/T1");
		expect(notificationTarget({ threadId: "T1" })).toBe("/#/threads/T1");
	});

	it("PSH-03 falls back to the payload's own route, then to the app root", () => {
		expect(clickTarget({ data: { url: "#/schedules?focus=S1" } })).toBe("/#/schedules?focus=S1");
		expect(clickTarget({ data: { url: "/files/F1/name.png" } })).toBe("/files/F1/name.png");
		expect(clickTarget({ data: {}, tag: "pana" })).toBe("/");
		expect(clickTarget(undefined)).toBe("/");
	});

	it("PSH-03 tags a delivery with its thread and a notice with nothing", () => {
		expect(notifyTag("T1")).toBe("pana:thread:T1");
		expect(notifyTag(undefined)).toBe("pana");
	});
});

describe("PSH-05 the click's target outlives the handoff between worker and page", () => {
	it("PSH-05 leaves a target the page takes exactly once", async () => {
		const storage = fakeStorage();
		expect(await leaveClickTarget(storage, "/#/threads/T1", 1_000)).toBe(true);
		expect(storage.entries.has(PENDING_KEY)).toBe(true);
		expect(await takeClickTarget(storage, 2_000)).toBe("/#/threads/T1");
		expect(await takeClickTarget(storage, 2_000)).toBeUndefined();
	});

	it("PSH-05 drops a target the reader has moved on from", async () => {
		const storage = fakeStorage();
		await leaveClickTarget(storage, "/#/threads/T1", 1_000);
		expect(await takeClickTarget(storage, 1_000 + 120_001)).toBeUndefined();
		await leaveClickTarget(storage, "/#/threads/T1", 1_000);
		expect(await takeClickTarget(storage, 1_000 + 120_000)).toBe("/#/threads/T1");
	});

	it("PSH-05 survives a cache that fails and a note that says nothing", async () => {
		expect(await leaveClickTarget(undefined, "/#/threads/T1")).toBe(false);
		expect(await takeClickTarget(undefined)).toBeUndefined();
		const broken = {
			async open() {
				throw new Error("no cache");
			},
		};
		expect(await leaveClickTarget(broken, "/#/threads/T1")).toBe(false);
		expect(await takeClickTarget(broken)).toBeUndefined();
		const storage = fakeStorage();
		const cache = await storage.open();
		await cache.put(PENDING_KEY, new Response("not json"));
		expect(await takeClickTarget(storage)).toBeUndefined();
	});
});

describe("PSH-05 the worker steers the window a click lands on", () => {
	// The worker registers its listeners once, at import; each test gives it a fresh `self`, which
	// its listener reads when a click arrives.
	const listeners = new Map<string, (event: unknown) => void>();

	/** Install a `self` a browser would provide, and click a notification shown for `T1`. */
	async function click(clients: unknown, storage = fakeStorage()) {
		vi.stubGlobal("self", {
			addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
			caches: storage,
			location: { origin: "https://pana.test" },
			clients,
			registration: { showNotification: async () => undefined },
		});
		await import("../web/sw.js");
		const waited: Array<Promise<unknown>> = [];
		listeners.get("notificationclick")!({
			notification: { close: () => undefined, data: { threadId: "T1" }, tag: "pana:thread:T1" },
			waitUntil: (promise: Promise<unknown>) => waited.push(promise),
		});
		await Promise.all(waited);
		return storage;
	}

	function fakeWindow(url: string) {
		const calls: string[] = [];
		return {
			calls,
			url,
			async focus() {
				calls.push("focus");
				return this;
			},
			postMessage(message: unknown) {
				calls.push(`message ${JSON.stringify(message)}`);
			},
			async navigate(target: string) {
				calls.push(`navigate ${target}`);
				return this;
			},
		};
	}

	it("PSH-05 focuses, messages, and navigates the open window, and leaves the target for it", async () => {
		const window = fakeWindow("https://pana.test/#/inbox");
		const storage = await click({ matchAll: async () => [window], openWindow: async () => undefined });
		expect(window.calls).toEqual([
			"focus",
			'message {"type":"open","target":"https://pana.test/#/threads/T1"}',
			"navigate https://pana.test/#/threads/T1",
		]);
		expect(await takeClickTarget(storage)).toBe("https://pana.test/#/threads/T1");
	});

	it("PSH-05 still messages a window whose browser will not navigate it", async () => {
		const window = fakeWindow("https://pana.test/#/inbox");
		Object.defineProperty(window, "navigate", {
			value: async () => {
				throw new Error("This service worker is not the client's active service worker.");
			},
		});
		await click({ matchAll: async () => [window], openWindow: async () => undefined });
		expect(window.calls).toEqual(["focus", 'message {"type":"open","target":"https://pana.test/#/threads/T1"}']);
	});

	it("PSH-05 opens a window when none is open", async () => {
		const opened: string[] = [];
		await click({
			matchAll: async () => [{ url: "https://elsewhere.test/" }],
			openWindow: async (target: string) => {
				opened.push(target);
			},
		});
		expect(opened).toEqual(["https://pana.test/#/threads/T1"]);
	});
});
