import { describe, expect, it } from "vitest";
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
		expect(denied).toEqual({ subscribed: false, reason: "permission denied" });
		expect(registered).toBe(0);

		const unavailable = await subscribeToPush({
			permission: "granted",
			register: async () => undefined,
			getKey: async () => "x",
			post: async () => {},
		});
		expect(unavailable).toEqual({ subscribed: false, reason: "push is not available" });
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
