// Tell the PWA and the user's devices about mail (PSH-03, INT-03).
//
// The store calls `announce` after its transaction commits, never inside it: a push is network
// I/O that must not hold the write queue, and a push that fails must not roll back the message.
// Push failures are reported and dropped; the message is already durable.

import type { Runtime } from "../server/runtime.ts";
import { publish } from "../web/index.ts";
import type { ThreadResult } from "./store.ts";

const PUSH_BODY_CHARS = 240;

function report(error: unknown): void {
	console.error("panad: push failed:", error instanceof Error ? error.message : error);
}

function excerpt(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > PUSH_BODY_CHARS ? `${flat.slice(0, PUSH_BODY_CHARS - 1)}…` : flat;
}

/**
 * Publish one event per recipient URL. `publish` streams it to open windows and pushes it when
 * the recipient is the user. Only the user reads the PWA, so other recipients are skipped.
 */
export function announce(runtime: Runtime, kind: "delivery" | "notice", result: ThreadResult, recipients: readonly string[]): void {
	if (!recipients.includes(runtime.userUrl)) return;
	const { thread, message } = result;
	const event = {
		kind,
		to: runtime.userUrl,
		threadId: thread.id,
		messageId: message.id,
		senderUrl: message.sender.url,
		title: thread.subject ?? (kind === "notice" ? "pana notice" : `Message from ${message.sender.url}`),
		...(message.body === undefined ? {} : { body: excerpt(message.body) }),
	};
	publish(runtime, event, report).catch(report);
}
