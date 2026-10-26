// Browser-side push subscription (PSH-02, UX-01). The caller supplies the browser hooks, so Node
// tests exercise every outcome without a real PushManager. Each way it can fail has its own
// `cause`, and `explainPush` turns a cause into the real reason and the fix.

export function urlBase64ToUint8Array(base64) {
	const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** A browser answer faster than this came without a prompt: nobody clicks that fast. */
export const NO_PROMPT_MS = 150;

/**
 * What the page can know about its browser before asking: `{secure, hasNotification,
 * hasServiceWorker, hasPushManager, standalone, browser, platform, origin, host}`. `browser` is
 * `safari`, `chrome`, `edge`, `firefox`, or `other`; `platform` is `mac`, `ios`, `android`,
 * `windows`, `linux`, or `other`.
 */
export function browserEnv({ userAgent = "", secure = true, hasNotification = true, hasServiceWorker = true, hasPushManager = true, standalone = false, origin = "", host = "" } = {}) {
	const ua = String(userAgent);
	let browser = "other";
	if (/Edg\//.test(ua)) browser = "edge";
	else if (/Firefox\//.test(ua)) browser = "firefox";
	else if (/Chrome\/|CriOS\//.test(ua)) browser = "chrome";
	else if (/Safari\//.test(ua) && /Version\//.test(ua)) browser = "safari";
	let platform = "other";
	if (/iPhone|iPad|iPod/.test(ua)) platform = "ios";
	else if (/Android/.test(ua)) platform = "android";
	else if (/Macintosh|Mac OS X/.test(ua)) platform = "mac";
	else if (/Windows/.test(ua)) platform = "windows";
	else if (/Linux/.test(ua)) platform = "linux";
	return { secure, hasNotification, hasServiceWorker, hasPushManager, standalone, browser, platform, origin, host };
}

/** True when the host is an IP literal rather than a name. */
export function isIpHost(host) {
	const name = String(host ?? "").replace(/:\d+$/, "");
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith("[") || (name.includes(":") && /^[0-9a-f:]+$/i.test(name));
}

/** The reason push cannot work here at all, before any prompt, or null when it can. */
export function pushSupport(env) {
	if (!env.secure) return { subscribed: false, cause: "insecure" };
	if (!env.hasNotification || !env.hasServiceWorker || !env.hasPushManager) return { subscribed: false, cause: "unsupported" };
	return null;
}

/**
 * Ask for permission, subscribe, and post the subscription. Returns a result rather than throwing
 * for the expected outcomes, each with a `cause`.
 *
 * `requestPermission` must be the first thing awaited: browsers grant the prompt only inside the
 * click's user activation, and Safari refuses it outright once the activation is spent. So the
 * support check is synchronous and nothing is fetched before the prompt.
 */
export async function subscribeToPush({ env, permission, requestPermission, register, getKey, post, now = () => Date.now() }) {
	const unsupported = env ? pushSupport(env) : null;
	if (unsupported) return unsupported;
	let state = permission;
	let asked = false;
	let elapsed = 0;
	if (state === "default" && typeof requestPermission === "function") {
		const started = now();
		state = await requestPermission();
		elapsed = now() - started;
		asked = true;
	}
	if (state === "denied") return { subscribed: false, cause: asked ? "denied" : "blocked", elapsed, reason: `permission ${state}` };
	if (state !== "granted") return { subscribed: false, cause: "dismissed", elapsed, reason: `permission ${state}` };

	let registration;
	try {
		registration = await register();
	} catch (error) {
		return { subscribed: false, cause: "no-worker", detail: errorText(error) };
	}
	if (!registration || !registration.pushManager) return { subscribed: false, cause: registration ? "unsupported" : "no-worker", reason: "push is not available" };

	let publicKey;
	try {
		publicKey = await getKey();
	} catch (error) {
		return { subscribed: false, cause: "no-key", detail: errorText(error) };
	}
	if (!publicKey) return { subscribed: false, cause: "no-key", reason: "the server has no VAPID key" };
	const key = urlBase64ToUint8Array(publicKey);

	let subscription;
	try {
		subscription = await registration.pushManager.getSubscription();
		// A subscription made for an older VAPID key (a new state directory) can never receive
		// pushes from this panad, and subscribe() refuses to replace it in place.
		if (subscription && !sameKey(subscription.options?.applicationServerKey, key)) {
			await subscription.unsubscribe();
			subscription = null;
		}
		if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	} catch (error) {
		return { subscribed: false, cause: "subscribe-failed", errorName: String(error?.name ?? "Error"), detail: errorText(error) };
	}

	try {
		await post(subscription.toJSON());
	} catch (error) {
		return { subscribed: false, cause: "server", detail: errorText(error) };
	}
	return { subscribed: true, endpoint: subscription.endpoint };
}

function sameKey(stored, key) {
	if (stored === undefined || stored === null) return true;
	const bytes = new Uint8Array(stored instanceof ArrayBuffer ? stored : (stored.buffer ?? stored));
	return bytes.length === key.length && bytes.every((byte, i) => byte === key[i]);
}

function errorText(error) {
	const name = error?.name && error.name !== "Error" ? `${error.name}: ` : "";
	return `${name}${error?.message ?? String(error)}`;
}

const BROWSER_NAMES = { chrome: "Chrome", edge: "Edge", firefox: "Firefox", safari: "Safari", other: "This browser" };

function siteSettings(env) {
	const origin = env.origin || "this site";
	switch (env.browser) {
		case "chrome":
		case "edge":
			return `Click the site controls icon left of the address, set Notifications to Allow for ${origin}, then click Notifications again.`;
		case "firefox":
			return `Click the permissions icon left of the address, clear the blocked Notifications permission for ${origin}, then click Notifications again.`;
		case "safari":
			return `Open Safari › Settings › Websites › Notifications, set ${origin} to Allow, reload, then click Notifications again.`;
		default:
			return `Allow notifications for ${origin} in the browser's site settings, then click Notifications again.`;
	}
}

function systemSettings(env) {
	if (env.platform !== "mac") return "";
	const app = env.browser === "safari" ? "Safari" : env.browser === "chrome" ? "Google Chrome" : BROWSER_NAMES[env.browser];
	return ` Also check System Settings › Notifications › ${app}.`;
}

/**
 * The message for a result: the real cause and how to fix it. `link`, when present, is a place
 * to go that fixes it, such as the same app on `localhost`.
 */
export function explainPush(result, env = browserEnv(), options = {}) {
	if (result.subscribed) return { text: "Notifications enabled." };
	const browser = BROWSER_NAMES[env.browser] ?? BROWSER_NAMES.other;
	switch (result.cause) {
		case "insecure":
			return {
				text: `Notifications need a secure page, and ${env.origin || "this page"} is not one. Open the app on this machine at http://127.0.0.1 or http://localhost, or on another device at the Tailscale https:// URL.`,
			};
		case "unsupported":
			if (env.platform === "ios" && !env.standalone) {
				return { text: "On iPhone and iPad, Web Push works only in the Home Screen app. In Safari, tap Share › Add to Home Screen, open pana from the Home Screen, and click Notifications there." };
			}
			return { text: `${browser} has no Web Push here. Use a current Chrome, Firefox, or Safari.` };
		case "blocked":
			return { text: `${browser} already blocks notifications for ${env.origin || "this site"}, so it did not ask. ${siteSettings(env)}` };
		case "denied": {
			if (env.browser === "safari" && isIpHost(env.host)) {
				const link = options.localhostUrl ? { href: options.localhostUrl, label: "Open pana on localhost" } : undefined;
				return {
					text: `Safari answered “denied” for ${env.host}, even if you chose Allow. Safari ties website notifications to a host name, and ${env.host.replace(/:\d+$/, "")} is an IP address. Open the app at localhost instead and turn on notifications there.`,
					...(link ? { link } : {}),
				};
			}
			if ((result.elapsed ?? NO_PROMPT_MS) < NO_PROMPT_MS) {
				return { text: `${browser} blocked notifications without showing a prompt. That happens in a private window, after a site was dismissed several times, or when notifications are off for every site. ${siteSettings(env)}` };
			}
			return { text: `${browser} answered “denied”. If you chose Allow, the system may be blocking ${browser}.${systemSettings(env)} Otherwise: ${siteSettings(env)}` };
		}
		case "dismissed":
			return {
				text:
					env.browser === "chrome" || env.browser === "edge"
						? `The prompt closed without a choice. ${browser} may have shown a quiet prompt instead: look for a crossed-out bell in the address bar. Click Notifications to ask again.`
						: "The prompt closed without a choice. Click Notifications to ask again.",
			};
		case "no-worker":
			return { text: `The service worker did not start${result.detail ? ` (${result.detail})` : ""}. Reload the page and click Notifications again.` };
		case "no-key":
			return { text: `panad did not give a push key${result.detail ? ` (${result.detail})` : ""}. Restart panad and try again.` };
		case "subscribe-failed":
			if (result.errorName === "AbortError") {
				return { text: `${browser} could not reach its push service (${result.detail}). Check the network. Chromium builds without Google's push service cannot subscribe; use Chrome.` };
			}
			if (result.errorName === "NotAllowedError") {
				return { text: `${browser} refused the push subscription although notifications are allowed (${result.detail}).${systemSettings(env)} ${siteSettings(env)}` };
			}
			return { text: `${browser} could not subscribe to push (${result.detail}).` };
		case "server":
			return { text: `panad did not store the subscription (${result.detail}).` };
		default:
			return { text: `Notifications are off: ${result.reason ?? result.cause ?? "unknown reason"}.` };
	}
}
