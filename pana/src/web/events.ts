// The PWA's live channel (WEB-06): one in-process hub of server-sent events per panad, and
// the fan-out that also turns user-facing events into Web Push (PSH-03).
//
// Other packages publish here instead of writing to a socket: a delivery that lands for the
// user is `{kind: "delivery", to: <user URL>, ...}`, and a notice is `{kind: "notice", ...}`.
// `publish` streams the event to open windows and pushes it when the user is away.

import type { ServerResponse } from "node:http";
import { messageFor, pushToParticipant, type SendSummary } from "../push/index.ts";
import type { Runtime } from "../server/runtime.ts";

export interface WebEvent {
	kind: string;
	/** Epoch milliseconds. Defaults to the runtime clock when published. */
	at?: number;
	/** The participant URL the event is for. Push fires only when this is the user. */
	to?: string;
	title?: string;
	body?: string;
	threadId?: string;
	sessionId?: string;
	/** An app route, such as `#/threads/<id>`, when the click target is not a thread. */
	url?: string;
	/** Anything else the client needs, such as a transcript entry. */
	[detail: string]: unknown;
}

interface Subscriber {
	send(event: WebEvent): void;
}

const hubs = new WeakMap<Runtime, Set<Subscriber>>();

function hub(runtime: Runtime): Set<Subscriber> {
	let set = hubs.get(runtime);
	if (!set) {
		set = new Set();
		hubs.set(runtime, set);
	}
	return set;
}

function frame(event: WebEvent): string {
	return `event: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Attach a response as an SSE subscriber. Returns the unsubscribe function; the caller must
 * also handle the response closing. The heartbeat keeps proxies from idling the connection out.
 */
export function subscribeEvents(runtime: Runtime, res: ServerResponse): () => void {
	const subscriber: Subscriber = {
		send: (event) => {
			try {
				res.write(frame(event));
			} catch {
				// A closed socket drops the subscriber below.
			}
		},
	};
	hub(runtime).add(subscriber);
	res.write("retry: 3000\n\n");
	subscriber.send({ kind: "hello", at: runtime.clock.now(), domain: runtime.config.domain, user: runtime.config.user });
	const heartbeat = runtime.clock.setTimer(() => {
		try {
			res.write(": ping\n\n");
		} catch {
			// Ignored; the close handler cleans up.
		}
	}, 25_000, { background: true });
	let stopped = false;
	const stop = () => {
		if (stopped) return;
		stopped = true;
		heartbeat?.();
		hub(runtime).delete(subscriber);
	};
	res.on("close", stop);
	res.on("error", stop);
	return stop;
}

/** How many windows the runtime currently has open. */
export function subscriberCount(runtime: Runtime): number {
	return hub(runtime).size;
}

/**
 * Stream an event to every open window, and push it when it is a delivery or notice addressed
 * to the user (PSH-03). Callers may ignore the promise; awaiting it makes push delivery
 * observable in tests.
 */
export async function publish(
	runtime: Runtime,
	event: WebEvent,
	onPushError: (error: unknown) => void = () => {},
): Promise<SendSummary | undefined> {
	const at = event.at ?? runtime.clock.now();
	const enriched: WebEvent = { ...event, at };
	for (const subscriber of hub(runtime)) subscriber.send(enriched);
	if (event.to !== runtime.userUrl) return undefined;
	if (event.kind !== "delivery" && event.kind !== "notice") return undefined;
	return pushToParticipant(runtime, runtime.config.user, messageFor(enriched), (error) => onPushError(error));
}
