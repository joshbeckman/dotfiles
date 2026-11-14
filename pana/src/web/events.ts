// The PWA's live channel (WEB-06): one in-process hub of server-sent events per panad, and
// the fan-out that also turns user-facing events into Web Push (PSH-03).
//
// Other packages publish here instead of writing to a socket: a delivery that lands for the
// user is `{kind: "delivery", to: <user URL>, ...}`, and a notice is `{kind: "notice", ...}`.
// `publish` streams the event to open windows and pushes it when the user is away. Each window
// gets only what its caller may see, so a session cannot watch another session's transcript.

import type { ServerResponse } from "node:http";
import type { Caller } from "../api/types.ts";
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
	caller: Caller;
	send(event: WebEvent): void;
}

/**
 * The event kinds that carry a session's own transcript. A committed entry holds tool arguments,
 * tool output, and model text; the live view holds the same for work in progress. Both belong to
 * the session that wrote them, so a session-caller subscriber sees only its own.
 * The user's windows still receive every session's, which is what the Sessions view follows.
 */
const OWNED_KINDS = new Set(["session.entry", "session.live"]);

function visibleTo(caller: Caller, event: WebEvent): boolean {
	if (!OWNED_KINDS.has(event.kind)) return true;
	if (caller.kind === "user") return true;
	return event.sessionId === caller.id;
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
 * Attach a response as an SSE subscriber, as the caller that opened it. Returns the unsubscribe
 * function; the caller must also handle the response closing. The heartbeat keeps proxies from
 * idling the connection out.
 */
export function subscribeEvents(runtime: Runtime, res: ServerResponse, caller: Caller): () => void {
	const subscriber: Subscriber = {
		caller,
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
	subscriber.send({ kind: "hello", at: runtime.clock.now(), domain: runtime.config.domain, user: runtime.config.user, userColor: runtime.config.ui?.userColor ?? "blue" });
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
 * Stream an event to every open window it is visible to, and return the enriched event (it carries
 * `at`). The fan-out is unconditional: a window is the cheapest way to tell the user something, and
 * the push gate never touches it.
 */
export function streamEvent(runtime: Runtime, event: WebEvent): WebEvent {
	const enriched: WebEvent = { ...event, at: event.at ?? runtime.clock.now() };
	for (const subscriber of hub(runtime)) {
		if (visibleTo(subscriber.caller, enriched)) subscriber.send(enriched);
	}
	return enriched;
}

/**
 * Push one event to the user's devices when it is a delivery or notice addressed to them
 * (PSH-03). A caller that has already streamed the event calls this itself, which is what lets the
 * push gate stand between the two (PSH-06).
 */
export async function pushEvent(
	runtime: Runtime,
	event: WebEvent,
	onPushError: (error: unknown) => void = () => {},
): Promise<SendSummary | undefined> {
	if (event.to !== runtime.userUrl) return undefined;
	if (event.kind !== "delivery" && event.kind !== "notice") return undefined;
	return pushToParticipant(runtime, runtime.config.user, messageFor(event), (error) => onPushError(error));
}

/**
 * Stream an event to every open window it is visible to, and push it when it is a delivery or
 * notice addressed to the user (PSH-03). Callers may ignore the promise; awaiting it makes push
 * delivery observable in tests.
 */
export async function publish(
	runtime: Runtime,
	event: WebEvent,
	onPushError: (error: unknown) => void = () => {},
): Promise<SendSummary | undefined> {
	return pushEvent(runtime, streamEvent(runtime, event), onPushError);
}
