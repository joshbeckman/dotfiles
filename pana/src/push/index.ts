// Web Push: VAPID keys, subscriptions, and delivery (PSH-01..04).
//
// `web-push` builds the encrypted request; the network transport pins its validated DNS answers.
// Tests can replace the transport per runtime through `setPushTransport`. A push that a push
// service no longer recognizes (404 or 410) deletes that subscription row (PSH-04).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import { Agent, request } from "node:https";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import webpush, { type PushSubscription, type VapidKeys } from "web-push";
import type { Runtime } from "../server/runtime.ts";
import { PUSH_CONCURRENCY, withPushSlot } from "./limits.ts";
export { PUSH_CONCURRENCY } from "./limits.ts";

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

// ---- Endpoint validation ------------------------------------------------------------------
//
// The endpoint is a URL a participant stores and panad fetches later, carrying the message body,
// so an unvalidated endpoint is a fetch primitive that survives a restart: it reaches internal
// ports and cloud metadata, and it exfiltrates message content to whoever named it. Storing a
// subscription is already user-only (`src/push/handlers.ts`), and these checks hold either way:
// what may be stored is decided once, and what may be fetched is decided again at send time.

/** The most subscriptions one participant may hold, so a fan-out stays bounded. */
export const MAX_SUBSCRIPTIONS = 5;

/** How long one push service gets before its send is abandoned. */
export const PUSH_TIMEOUT_MS = 10_000;

/**
 * Names that can only resolve inside a machine or a private network: loopback aliases, mDNS,
 * cloud metadata, and Tailscale's MagicDNS. A push service is a public HTTPS host, so none of
 * these can be a browser's push endpoint.
 */
const INTERNAL_SUFFIXES = [
	"localhost",
	"local",
	"localdomain",
	"internal",
	"home.arpa",
	"ts.net",
	"metadata.google.internal",
	"instance-data",
	"ec2.internal",
	"compute.internal",
];

/** Why a stored endpoint may not be fetched, or `undefined` when it is acceptable. */
export function endpointProblem(endpoint: string): string | undefined {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return "is not a URL";
	}
	if (url.protocol !== "https:") return "must use https";
	if (url.username !== "" || url.password !== "") return "must not carry credentials";
	// `URL` drops an explicit `:443`, so a port here is always a non-default one.
	if (url.port !== "") return "must use the default https port";
	const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
	if (isIP(host) !== 0) return "must not name an IP address";
	if (!host.includes(".")) return "must name a public host";
	const lower = host.toLowerCase();
	if (INTERNAL_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))) {
		return "must name a public host";
	}
	return undefined;
}

// IPv4-compatible and mapped IPv6 addresses can reach IPv4 destinations, including private ones.
// Reject the entire ranges, including expanded and hex-encoded forms.
const embeddedIPv4 = new BlockList();
embeddedIPv4.addSubnet("::", 96, "ipv6");
embeddedIPv4.addSubnet("::ffff:0:0", 96, "ipv6");

/** Whether an address a hostname resolved to is routable on the public internet. */
export function isPublicAddress(address: string): boolean {
	const bare = address.toLowerCase().split("%")[0]!;
	if (isIP(bare) === 4) {
		const octets = bare.split(".").map(Number);
		const [a, b] = octets as [number, number, number, number];
		if (a === 0 || a === 10 || a === 127) return false;
		if (a === 169 && b === 254) return false;
		if (a === 172 && b >= 16 && b <= 31) return false;
		if (a === 192 && (b === 0 || b === 168)) return false;
		if (a === 100 && b >= 64 && b <= 127) return false;
		if (a === 198 && (b === 18 || b === 19)) return false;
		if (a >= 224) return false;
		return true;
	}
	if (isIP(bare) === 6) {
		if (embeddedIPv4.check(bare, "ipv6")) return false;
		const first = Number.parseInt(bare.split(":")[0] || "0", 16);
		if ((first & 0xfe00) === 0xfc00) return false; // unique-local fc00::/7
		if ((first & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
		if ((first & 0xff00) === 0xff00) return false; // multicast ff00::/8
		return true;
	}
	return false;
}

/** Resolve once and bind the HTTPS connection to those validated answers. The URL stays intact,
 * so HTTP Host, TLS SNI and certificate verification all use the original hostname.
 */
export async function publicPushAgent(endpoint: string, signal: AbortSignal, resolver = new Resolver()): Promise<Agent> {
	const host = new URL(endpoint).hostname;
	if (signal.aborted) throw new Error("push send aborted");
	const abort = () => resolver.cancel();
	signal.addEventListener("abort", abort, { once: true });
	let addresses: Array<{ address: string; family: number }>;
	try {
		const query = async (family: 4 | 6) => {
			try {
				const result = family === 4 ? await resolver.resolve4(host) : await resolver.resolve6(host);
				return result.map((address) => ({ address, family }));
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENODATA" || code === "ENOTFOUND") return [];
				throw error;
			}
		};
		const [v4, v6] = await Promise.all([query(4), query(6)]);
		if (signal.aborted) throw new Error("push send aborted");
		addresses = [...v4, ...v6];
	} catch (error) {
		if (!signal.aborted) resolver.cancel();
		throw error;
	} finally {
		signal.removeEventListener("abort", abort);
	}
	if (addresses.length === 0) throw new Error(`${host} does not resolve`);
	const blocked = addresses.find((entry) => !isPublicAddress(entry.address));
	if (blocked) throw new Error(`${host} resolves to a non-public address (${blocked.address})`);

	return new Agent({
		lookup: (hostname, options, callback) => {
			const matches = hostname === host ? addresses.filter((entry) => !options.family || entry.family === options.family) : [];
			if (matches.length === 0) {
				callback(new Error(`no validated address for ${hostname}`), "", 0);
			} else if (options.all) {
				callback(null, matches);
			} else {
				callback(null, matches[0]!.address, matches[0]!.family);
			}
		},
	});
}

/** Send generated web-push bytes through the pinned agent, and destroy the socket on abort. */
export async function sendPinnedRequest(
	endpoint: string,
	details: { method: string; headers: import("node:http").OutgoingHttpHeaders; body?: Buffer },
	agent: Agent,
	signal: AbortSignal,
): Promise<void> {
	if (signal.aborted) throw new Error("push send aborted");
	await new Promise<void>((resolve, reject) => {
		const req = request(endpoint, { method: details.method, headers: details.headers, agent }, (res) => {
			res.resume();
			res.on("error", reject);
			res.on("end", () => {
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
				else reject(Object.assign(new Error(`push service returned ${res.statusCode}`), { statusCode: res.statusCode }));
			});
		});
		const abort = () => req.destroy(new Error("push send aborted"));
		signal.addEventListener("abort", abort, { once: true });
		req.once("close", () => signal.removeEventListener("abort", abort));
		req.on("error", reject);
		if (signal.aborted) abort();
		else req.end(details.body);
	});
}

/** Reject a send that outlives its budget, so one hung endpoint cannot hold a fan-out open. */
async function withTimeout<T>(runtime: Runtime, work: (signal: AbortSignal) => Promise<T>, ms: number = PUSH_TIMEOUT_MS): Promise<T> {
	const control = new AbortController();
	let cancel: (() => void) | undefined;
	const expired = new Promise<never>((_, reject) => {
		// The budget includes time waiting for a global transport slot.
		cancel = runtime.clock.setTimer(() => {
			const error = new Error(`push send timed out after ${ms} ms`);
			reject(error);
			control.abort(error);
		}, ms, { background: false });
	});
	try {
		return await Promise.race([withPushSlot(control.signal, () => work(control.signal)), expired]);
	} finally {
		cancel?.();
	}
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
	signal: AbortSignal,
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
	return async (subscription, message, vapid, signal?: AbortSignal) => {
		// The caller supplies a deadline signal when the timeout transport is integrated.
		const deadline = signal ?? new AbortController().signal;
		const agent = await publicPushAgent(subscription.endpoint, deadline);
		try {
			const details = webpush.generateRequestDetails(subscription, JSON.stringify(message), {
				vapidDetails: {
					subject: vapidSubject(runtime),
					publicKey: vapid.publicKey,
					privateKey: vapid.privateKey,
				},
				TTL: 60 * 60 * 24,
				urgency: "normal",
			});
			await sendPinnedRequest(subscription.endpoint, details, agent, deadline);
		} finally {
			agent.destroy();
		}
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
	const problem = endpointProblem(subscription.endpoint);
	if (problem) {
		// A row that would never be fetched is dropped: it cannot deliver, and left in place it
		// would hold a slot in the cap and keep asking panad to reach an address it refuses.
		await runtime.db.write((tx) => tx.run("DELETE FROM push_subscriptions WHERE endpoint = ?", subscription.endpoint));
		onError(new Error(`push endpoint ${subscription.endpoint} ${problem}`), subscription);
		return "gone";
	}
	try {
		await withTimeout(
			runtime,
			(signal) => transportFor(runtime)(
				{ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
				message,
				vapidKeys(runtime),
				signal,
			),
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

/** Send to every subscription a participant holds, a bounded few at a time. */
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
	const queue = [...rows];
	const worker = async () => {
		for (let row = queue.shift(); row; row = queue.shift()) {
			const outcome = await sendToSubscription(runtime, row, message, onError);
			summary[outcome]++;
		}
	};
	await Promise.all(Array.from({ length: Math.min(PUSH_CONCURRENCY, rows.length) }, worker));
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
