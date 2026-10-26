// Browser-side push subscription (PSH-02). The caller supplies permission and registration
// hooks so Node tests can exercise the decision without a real PushManager.

export function urlBase64ToUint8Array(base64) {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/**
 * Ask for permission, subscribe if the user allows it, and post the subscription. Returns a
 * result rather than throwing for the expected outcomes: denied permission and a browser
 * without push are normal, not errors.
 */
export async function subscribeToPush({ permission, requestPermission, register, getKey, post }) {
	let state = permission;
	if (state === "default" && typeof requestPermission === "function") state = await requestPermission();
	if (state !== "granted") return { subscribed: false, reason: `permission ${state}` };
	const registration = await register();
	if (!registration || !registration.pushManager) return { subscribed: false, reason: "push is not available" };
	let subscription = await registration.pushManager.getSubscription();
	if (!subscription) {
		const publicKey = await getKey();
		if (!publicKey) return { subscribed: false, reason: "the server has no VAPID key" };
		subscription = await registration.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey),
		});
	}
	await post(subscription.toJSON());
	return { subscribed: true, endpoint: subscription.endpoint };
}
