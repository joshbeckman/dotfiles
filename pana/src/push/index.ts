// Web Push: VAPID keys, subscriptions, and delivery (PSH-01..04).
//
// `web-push` is the only sender. Tests replace the transport per runtime through
// `setPushTransport`, so no test reaches the network. A push that a push service no longer
// recognizes (404 or 410) deletes that subscription row (PSH-04).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush, { type PushSubscription, type VapidKeys } from "web-push";
import type { Runtime } from "../server/runtime.ts";

/** The file under the state directory that holds the domain's VAPID key pair. */
export const VAPID_FILE = "vapid.json";

export function vapidPath(dir: string): string {
	return join(dir, VAPID_FILE);
}

/**
 * Read the VAPID pair, or make and store one on first start (PSH-01). The file is 0600: the
 * private key signs every push and is as sensitive as the web token.
 */
export function ensureVapidKeys(dir: string): VapidKeys {
	const path = vapidPath(dir);
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidKeys>;
		if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
			return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
		}
	}
	const keys = webpush.generateVAPIDKeys();
	writeFileSync(path, `${JSON.stringify(keys, null, "\t")}\n`, { mode: 0o600 });
	return keys;
}

const keysByRuntime = new WeakMap<Runtime, VapidKeys>();

/** Load the keys once per panad, which also creates them when panad starts on empty state. */
export function initPush(runtime: Runtime): VapidKeys {
	const keys = ensureVapidKeys(runtime.paths.dir);
	keysByRuntime.set(runtime, keys);
	return keys;
}

export function vapidKeys(runtime: Runtime): VapidKeys {
	return keysByRuntime.get(runtime) ?? initPush(runtime);
}

/** The subscription payload the browser gets from `PushSubscription.toJSON()`. */
export interface StoredSubscription {
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
}

export interface PushMessage {
	title: string;
	body?: string;
	/** The thread a click should open (PSH-03). */
	threadId?: string;
	/** A ready-made app route, when the click target is not a thread. */
	url?: string;
	tag?: string;
}

/** Sends one message. Tests inject a fake; production uses `web-push`. */
export type PushTransport = (
	subscription: PushSubscription,
	message: PushMessage,
	vapid: VapidKeys,
) => Promise<void>;

const transports = new WeakMap<Runtime, PushTransport>();

/** Replace the sender for this panad. Tests use it to avoid the network. */
export function setPushTransport(runtime: Runtime, transport: PushTransport | undefined): void {
	if (transport) transports.set(runtime, transport);
	else transports.delete(runtime);
}

function vapidSubject(runtime: Runtime): string {
	// VAPID requires a contact URI. Pana has no mailbox of its own, so name the domain.
	return `mailto:pana@${runtime.config.domain}`;
}

/** A transport that uses the runtime's domain in the VAPID subject. */
function transportFor(runtime: Runtime): PushTransport {
	const custom = transports.get(runtime);
	if (custom) return custom;
	return async (subscription, message, vapid) => {
		await webpush.sendNotification(subscription, JSON.stringify(message), {
			vapidDetails: {
				subject: vapidSubject(runtime),
				publicKey: vapid.publicKey,
				privateKey: vapid.privateKey,
			},
			TTL: 60 * 60 * 24,
			urgency: "normal",
		});
	};
}

export type PushOutcome = "sent" | "gone" | "failed";

function statusCodeOf(error: unknown): number | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	const value = (error as { statusCode?: unknown }).statusCode;
	return typeof value === "number" ? value : undefined;
}

/**
 * Send to one stored subscription. A push service that answers 404 or 410 has forgotten the
 * subscription, so the row is deleted (PSH-04). Any other failure is reported and kept: the
 * subscription may still be valid after a transient error.
 */
export async function sendToSubscription(
	runtime: Runtime,
	subscription: StoredSubscription,
	message: PushMessage,
	onError: (error: unknown, subscription: StoredSubscription) => void = () => {},
): Promise<PushOutcome> {
	try {
		await transportFor(runtime)(
			{ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
			message,
			vapidKeys(runtime),
		);
		return "sent";
	} catch (error) {
		const status = statusCodeOf(error);
		if (status === 404 || status === 410) {
			await runtime.db.write((tx) => tx.run("DELETE FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint));
			return "gone";
		}
		onError(error, subscription);
		return "failed";
	}
}

export interface SendSummary {
	sent: number;
	gone: number;
	failed: number;
}

/** Send to every subscription a participant holds. */
export async function pushToParticipant(
	runtime: Runtime,
	participantId: string,
	message: PushMessage,
	onError: (error: unknown, subscription: StoredSubscription) => void = () => {},
): Promise<SendSummary> {
	const rows = await runtime.db.all<{ id: string; endpoint: string; p256dh: string; auth: string }>(
		"SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE participant_id = ? ORDER BY created_at",
		participantId,
	);
	const summary: SendSummary = { sent: 0, gone: 0, failed: 0 };
	for (const row of rows) {
		const outcome = await sendToSubscription(runtime, row, message, onError);
		summary[outcome]++;
	}
	return summary;
}

/**
 * A delivery's tag names its thread: one notification per thread, replaced by the next. The tag is
 * also the click's fallback, so `web/links.js` reads the same prefix to find the thread when a
 * browser drops the notification's `data`.
 */
export const THREAD_TAG_PREFIX = "pana:thread:";

/** A push message for an event that the user must see even when no window is open. */
export function messageFor(event: { title?: string; body?: string; threadId?: string; url?: string; kind: string }): PushMessage {
	return {
		title: event.title ?? (event.kind === "notice" ? "pana notice" : "pana"),
		...(event.body === undefined ? {} : { body: event.body }),
		...(event.threadId === undefined ? {} : { threadId: event.threadId }),
		...(event.url === undefined ? {} : { url: event.url }),
		tag: event.threadId === undefined ? "pana" : `${THREAD_TAG_PREFIX}${event.threadId}`,
	};
}
